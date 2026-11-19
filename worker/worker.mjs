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

    const body = [description, ...imageLinks].filter(Boolean).join('\n\n');
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
    return json(request, { number: result.number, url: result.html_url }, 201);
  } catch (error) {
    await Promise.all(uploadedKeys.map(key => env.ISSUE_IMAGES.delete(key)));
    return json(request, { error: error.message || '提交失败，请稍后重试。' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname === '/api/issues') {
      if (request.headers.get('Origin') !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
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
    return json(request, { error: 'Not found' }, 404);
  },
};
