const repository = 'chengfengsunce/dashboard';
const allowedOrigin = 'https://chengfengsunce.github.io';
const maxRequestBytes = 8_000_000;
const maxImageBytes = 2_000_000;
const maxImages = 4;
const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

function json(request, body, status = 200) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (request.headers.get('Origin') === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function sendDingTalk(env, title, submitter, project, url) {
  if (!env.DINGTALK_APP_KEY || !env.DINGTALK_SECRET || !env.DINGTALK_ROBOT_CODE) {
    throw new Error('钉钉应用通知尚未配置完整。');
  }
  const tokenResponse = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: env.DINGTALK_APP_KEY, appSecret: env.DINGTALK_SECRET }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.accessToken) throw new Error('钉钉应用认证失败，请检查 Client ID 和 Client Secret。');
  const headers = { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token.accessToken };
  const searchResponse = await fetch('https://api.dingtalk.com/v1.0/contact/users/search', {
    method: 'POST', headers,
    body: JSON.stringify({ queryWord: submitter, offset: 0, size: 20 }),
  });
  const search = await searchResponse.json();
  if (!searchResponse.ok) throw new Error('无法查找提出人，请开通钉钉通讯录搜索权限（qyapi_addresslist_search），并检查通讯录可见范围。');
  if (search.hasMore) throw new Error('提出人姓名匹配结果过多，请填写完整姓名后重试。');
  const matches = [];
  for (const userid of new Set(search.list || [])) {
    const userResponse = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token.accessToken), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid }),
    });
    const user = await userResponse.json();
    if (!userResponse.ok || user.errcode !== 0) throw new Error('无法核对提出人姓名，请开通钉钉成员信息读取权限（qyapi_get_member），并检查通讯录可见范围。');
    if (user.result?.name === submitter && user.result.userid) matches.push(user.result.userid);
  }
  if (!matches.length) throw new Error(`未找到提出人“${submitter}”的钉钉账号，请检查姓名和通讯录可见范围。`);
  if (matches.length !== 1) throw new Error(`钉钉中有多位“${submitter}”，为避免通知错人，本次未发送。`);
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST', headers,
    body: JSON.stringify({
      robotCode: env.DINGTALK_ROBOT_CODE,
      userIds: matches,
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: `需求已完成：${title}\n项目：${project}\n详情：${url}` }),
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.processQueryKey) throw new Error('钉钉机器人未接受通知，请检查机器人编码和消息发送权限。');
  if (result.invalidStaffIdList?.length || result.filteredStaffIdList?.length) throw new Error('钉钉机器人无法通知该提出人，请检查应用可用范围和接收人账号。');
  if (result.flowControlledStaffIdList?.length) throw new Error('钉钉通知触发限流，请稍后重试。');
}

async function submitIssue(request, env) {
  if (request.headers.get('Origin') !== allowedOrigin) return json(request, { error: '提交来源无效。' }, 403);
  if (!env.GITHUB_TOKEN) return json(request, { error: '自动提交通道未配置 GitHub 密钥。' }, 503);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > maxRequestBytes) return json(request, { error: '内容或图片太大，请缩小后重试。' }, 413);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limit = await env.SUBMIT_RATE_LIMIT.limit({ key: ip });
  if (!limit.success) return json(request, { error: '提交太频繁，请稍后再试。' }, 429);

  const reader = request.body?.getReader();
  const chunks = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxRequestBytes) {
        await reader.cancel();
        return json(request, { error: '内容或图片太大，请缩小后重试。' }, 413);
      }
      chunks.push(value);
    }
  }

  let form;
  try {
    const contentType = request.headers.get('Content-Type');
    form = await new Response(new Blob(chunks), { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    return json(request, { error: '提交内容无法读取。' }, 400);
  }
  if (form.get('company_website')) return json(request, { error: '提交未通过检查。' }, 400);

  const title = String(form.get('title') || '').trim();
  const description = String(form.get('body') || '').trim();
  const project = String(form.get('project') || repository).trim();
  const submitter = String(form.get('submitter') || '').trim();
  if (!/^chengfengsunce\/[a-zA-Z0-9_.-]+$/.test(project) || !submitter || submitter.length > 60 || /[<>\r\n]/.test(submitter)) {
    return json(request, { error: '请选择所属项目，并填写不超过 60 字的提出人姓名。' }, 400);
  }
  if (!title || title.length > 180 || description.length > 20_000) {
    return json(request, { error: '请填写标题，并确认标题、说明没有超出长度限制。' }, 400);
  }

  const images = form.getAll('image');
  if (images.length > maxImages) return json(request, { error: `最多添加 ${maxImages} 张图片。` }, 400);
  let totalImageBytes = 0;
  for (const image of images) {
    if (!image || typeof image.stream !== 'function' || !imageTypes.has(image.type) || image.size > maxImageBytes) {
      return json(request, { error: '图片只支持小于 2 MB 的 JPG、PNG、GIF 或 WebP。' }, 400);
    }
    totalImageBytes += image.size;
  }
  if (totalImageBytes > 6_000_000) return json(request, { error: '图片总大小不能超过 6 MB。' }, 400);
  if (images.length && !env.ISSUE_IMAGES) return json(request, { error: '图片存储尚未配置。' }, 503);

  const uploadedKeys = [];
  try {
    const imageLinks = [];
    for (const image of images) {
      const key = `${crypto.randomUUID()}.${imageTypes.get(image.type)}`;
      await env.ISSUE_IMAGES.put(key, image.stream(), { httpMetadata: { contentType: image.type } });
      uploadedKeys.push(key);
      imageLinks.push(`![需求截图](${new URL(`/images/${key}`, request.url)})`);
    }

    const metadata = '<!-- dashboard-meta:' + JSON.stringify({ project, submitter }) + ' -->';
    const body = [metadata, description, ...imageLinks].filter(Boolean).join('\n\n');
    const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dashboard-issue-form',
      },
      body: JSON.stringify({ title, body }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'GitHub 创建需求失败。');
    return json(request, { number: result.number, url: result.html_url, created_at: result.created_at, updated_at: result.updated_at }, 201);
  } catch (error) {
    await Promise.all(uploadedKeys.map(key => env.ISSUE_IMAGES.delete(key)));
    return json(request, { error: error.message || '提交失败，请稍后重试。' }, 502);
  }
}

async function completeIssue(request, env, target, number) {
  if (request.headers.get('Origin') !== allowedOrigin) return json(request, { error: '操作来源无效。' }, 403);
  if (!env.GITHUB_TOKEN) return json(request, { error: '需求完成功能尚未配置。' }, 503);
  if (!target.startsWith(repository.split('/')[0] + '/')) return json(request, { error: '不允许操作其他账号的项目。' }, 403);
  const limit = await env.SUBMIT_RATE_LIMIT.limit({ key: 'admin:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!limit.success) return json(request, { error: '操作太频繁，请稍后再试。' }, 429);
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dashboard-issue-form',
  };
  const issueUrl = 'https://api.github.com/repos/' + target + '/issues/' + number;
  let notify = false;
  try {
    const payload = await request.json();
    notify = payload?.notify_submitter === true;
  } catch {
    return json(request, { error: '无法读取完成选项，请刷新后重试。' }, 400);
  }
  try {
    const original = await fetch(issueUrl, { headers });
    const issue = await original.json();
    if (!original.ok) throw new Error('无法读取需求，请检查 GitHub 密钥的项目权限。');
    if (issue.pull_request) return json(request, { error: '不能将代码合并请求作为需求完成。' }, 400);
    let result = issue;
    if (issue.state !== 'closed') {
      const response = await fetch(issueUrl, {
        method: 'PATCH', headers, body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      });
      result = await response.json();
      if (!response.ok || result.state !== 'closed') throw new Error('需求完成失败，请检查 GitHub 密钥的 Issues 写入权限。');
    }
    let notification = 'skipped';
    let notificationError;
    if (notify) {
      try {
        let metadata = {};
        const header = (issue.body || '').split('\n')[0].trim();
        if (header.startsWith('<!-- dashboard-meta:') && header.endsWith(' -->')) {
          try { metadata = JSON.parse(header.slice(20, -4)); } catch {}
        }
        const submitter = typeof metadata?.submitter === 'string' ? metadata.submitter.trim() : '';
        if (!submitter) throw new Error('需求中未填写提出人，无法发送钉钉通知。');
        const project = metadata.project || target;
        await sendDingTalk(env, issue.title, submitter, project, issue.html_url);
        notification = 'queued';
      } catch (error) {
        notification = 'failed';
        notificationError = error.message || '钉钉通知发送失败，请稍后重试。';
      }
    }
    return json(request, { state: 'closed', updated_at: result.updated_at, notification, notification_error: notificationError });
  } catch (error) {
    return json(request, { error: error.message || '需求完成失败，请稍后重试。' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const issueRoute = url.pathname.match(/^\/api\/issues\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([1-9][0-9]*)$/);
    if (request.method === 'OPTIONS' && (url.pathname === '/api/issues' || issueRoute)) {
      if (request.headers.get('Origin') !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(request, { ok: true, configured: Boolean(env.GITHUB_TOKEN && env.ISSUE_IMAGES) });
    }
    if (request.method === 'GET' && /^\/images\/[0-9a-f-]+\.(jpg|png|gif|webp)$/.test(url.pathname)) {
      const object = await env.ISSUE_IMAGES?.get(url.pathname.slice('/images/'.length));
      if (!object) return new Response('Not found', { status: 404 });
      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/issues') return submitIssue(request, env);
    if (request.method === 'PATCH' && issueRoute) return completeIssue(request, env, issueRoute[1] + '/' + issueRoute[2], issueRoute[3]);
    return json(request, { error: 'Not found' }, 404);
  },
};
