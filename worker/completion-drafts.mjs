const allowedOrigin = 'https://chengfengsunce.github.io';

function readMetadata(issue) {
  const body = issue.body || '';
  const header = body.split('\n', 1)[0].trim();
  if (header.startsWith('<!-- dashboard-meta:') && header.endsWith(' -->')) {
    try {
      const metadata = JSON.parse(header.slice('<!-- dashboard-meta:'.length, -' -->'.length));
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        return { metadata, remaining: body.includes('\n') ? body.slice(body.indexOf('\n')) : '' };
      }
    } catch {}
  }
  return { metadata: {}, remaining: body ? '\n\n' + body : '' };
}

function draftResult(issue, metadata, target, number) {
  return { repo: target, number: Number(number), title: issue.title, state: issue.state,
    completion_summary: typeof metadata.completion_draft === 'string' ? metadata.completion_draft
      : typeof metadata.completion_summary === 'string' ? metadata.completion_summary : '',
    revision: typeof metadata.completion_draft_revision === 'string' ? metadata.completion_draft_revision : '',
    updated_at: metadata.completion_draft_updated_at || '',
  };
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      const error = new Error('草稿内容过大，每项最多 500 字。');
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { return null; }
}

export async function completionDraft(request, env, target, number, json) {
  if (request.headers.get('Origin') !== allowedOrigin) return json(request, { error: '操作来源无效。' }, 403);
  if (!/^chengfengsunce\/[a-zA-Z0-9_.-]+$/.test(target)) return json(request, { error: '不允许操作其他账号的项目。' }, 403);
  if (!env.GITHUB_TOKEN || !env.DRAFT_RATE_LIMIT) return json(request, { error: '完成说明草稿功能尚未配置。' }, 503);
  let payload;
  if (request.method === 'PUT') {
    try { payload = await readPayload(request); } catch (error) { return json(request, { error: error.message }, error.status || 400); }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || typeof payload.completion_summary !== 'string' || payload.completion_summary.trim().length > 500
      || typeof payload.revision !== 'string' || payload.revision.length > 100
      || Object.keys(payload).some(key => !['completion_summary', 'revision'].includes(key))) {
      return json(request, { error: '草稿内容或版本无效，每项说明最多 500 字。' }, 400);
    }
  }
  const limit = await env.DRAFT_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
  if (!limit.success) return json(request, { error: '草稿保存太频繁，内容已留在本机，请稍后重试。' }, 429);
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dashboard-completion-draft' };
  const url = `https://api.github.com/repos/${target}/issues/${number}`;
  try {
    const response = await fetch(url, { headers });
    const issue = await response.json();
    if (!response.ok) return json(request, { error: '无法读取需求草稿，请稍后重试。' }, response.status === 404 ? 404 : 502);
    if (issue.pull_request) return json(request, { error: '不能为代码合并请求保存需求完成说明。' }, 400);
    const { metadata, remaining } = readMetadata(issue);
    const current = draftResult(issue, metadata, target, number);
    if (request.method === 'GET') return json(request, current);
    const summary = payload.completion_summary.trim();
    if (summary === current.completion_summary && typeof metadata.completion_draft === 'string') return json(request, current);
    if (payload.revision !== current.revision) return json(request, { ...current, error: '另一处已更新说明，当前修改已留在本机，请核对后保存。' }, 409);
    const saved = { ...metadata, completion_draft: summary,
      completion_draft_revision: crypto.randomUUID(), completion_draft_updated_at: new Date().toISOString() };
    const update = await fetch(url, { method: 'PATCH', headers,
      body: JSON.stringify({ body: '<!-- dashboard-meta:' + JSON.stringify(saved) + ' -->' + remaining }) });
    const result = await update.json();
    if (!update.ok) return json(request, { error: '云端草稿保存失败，当前修改已留在本机。' }, 502);
    return json(request, draftResult(result, saved, target, number));
  } catch {
    return json(request, { error: '云端草稿暂时无法连接，当前修改已留在本机。' }, 502);
  }
}
