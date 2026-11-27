function metadataFor(body) {
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

async function resultFor(issue, metadata, repo, number) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([issue.updated_at, issue.body || '', issue.state])));
  const revision = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { repo, number: Number(number), title: issue.title, state: issue.state,
    submitter: typeof metadata.submitter === 'string' && metadata.submitter.trim()
      ? metadata.submitter : issue.user?.login || '未知',
    revision, updated_at: issue.updated_at };
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      const error = new Error('修改内容过大，姓名最多60字。');
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { return null; }
}

export async function editSubmitter(request, env, repo, number, json) {
  if (request.headers.get('Origin') !== 'https://chengfengsunce.github.io') return json(request, { error: '操作来源无效。' }, 403);
  if (!/^chengfengsunce\/[a-zA-Z0-9_.-]+$/.test(repo)) return json(request, { error: '不允许修改其他账号的需求。' }, 403);
  if (!env.GITHUB_TOKEN || !env.DRAFT_RATE_LIMIT) return json(request, { error: '提出人编辑功能尚未配置。' }, 503);
  let payload;
  if (request.method === 'PATCH') {
    try { payload = await readPayload(request); } catch (error) { return json(request, { error: error.message }, error.status || 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.submitter !== 'string' || !payload.submitter.trim() || payload.submitter.trim().length > 60 || /[<>\r\n]/.test(payload.submitter)
      || typeof payload.revision !== 'string' || !payload.revision || payload.revision.length > 100
      || Object.keys(payload).some(key => !['submitter', 'revision'].includes(key))) {
      return json(request, { error: '请填写不超过60字的提出人姓名，并重新读取最新需求。' }, 400);
    }
  }
  const limit = await env.DRAFT_RATE_LIMIT.limit({ key: 'submitter:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!limit.success) return json(request, { error: '修改太频繁，请稍后重试。' }, 429);
  const url = `https://api.github.com/repos/${repo}/issues/${number}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dashboard-submitter-editor' };
  try {
    const response = await fetch(url, { headers });
    const issue = await response.json();
    if (!response.ok) return json(request, { error: '无法读取需求，请稍后重试。' }, response.status === 404 ? 404 : 502);
    if (issue.pull_request) return json(request, { error: '代码合并请求不支持修改需求提出人。' }, 400);
    const { metadata, remaining } = metadataFor(issue.body || '');
    const current = await resultFor(issue, metadata, repo, number);
    if (request.method === 'GET') return json(request, current);
    const submitter = payload.submitter.trim();
    if (submitter === current.submitter) return json(request, current);
    if (payload.revision !== current.revision) return json(request, { ...current, error: '需求已被其他操作更新，请重新读取后再修改。' }, 409);
    const saved = { ...metadata, submitter };
    const updated = await fetch(url, { method: 'PATCH', headers,
      body: JSON.stringify({ body: '<!-- dashboard-meta:' + JSON.stringify(saved) + ' -->' + remaining }) });
    const result = await updated.json();
    if (!updated.ok) return json(request, { error: '提出人保存失败，输入内容已保留，请稍后重试。' }, 502);
    return json(request, await resultFor(result, saved, repo, number));
  } catch {
    return json(request, { error: '暂时无法确认保存结果，请重新读取需求后核对。' }, 502);
  }
}
