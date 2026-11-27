import { sendCompletionNotifications } from './notifications.mjs';
import { completionDraft } from './completion-drafts.mjs';
import { editSubmitter } from './submitter.mjs';

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
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
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

async function completeRequirement(env, target, number, completionSummary) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dashboard-issue-form',
  };
  const issueUrl = 'https://api.github.com/repos/' + target + '/issues/' + number;
  const original = await fetch(issueUrl, { headers });
  const issue = await original.json();
  if (!original.ok) throw new Error('无法读取需求，请检查 GitHub 密钥的项目权限。');
  if (issue.pull_request) {
    const error = new Error('不能将代码合并请求作为需求完成。');
    error.status = 400;
    throw error;
  }
  let metadata = {};
  const issueBody = issue.body || '';
  const header = issueBody.split('\n')[0].trim();
  let hasMetadataHeader = false;
  if (header.startsWith('<!-- dashboard-meta:') && header.endsWith(' -->')) {
    try {
      const parsed = JSON.parse(header.slice(20, -4));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
        hasMetadataHeader = true;
      }
    } catch {}
  }
  const update = {};
  if (issue.state !== 'closed') {
    update.state = 'closed';
    update.state_reason = 'completed';
  }
  if (typeof completionSummary === 'string' && (completionSummary !== metadata.completion_summary
      || (typeof metadata.completion_draft === 'string' && completionSummary !== metadata.completion_draft))) {
    metadata = { ...metadata, completion_summary: completionSummary,
      ...(typeof metadata.completion_draft === 'string' ? { completion_draft: completionSummary,
        completion_draft_revision: crypto.randomUUID(), completion_draft_updated_at: new Date().toISOString() } : {}) };
    const headerEnd = issueBody.indexOf('\n');
    const remainingBody = hasMetadataHeader ? (headerEnd < 0 ? '' : issueBody.slice(headerEnd)) : (issueBody ? '\n\n' + issueBody : '');
    update.body = '<!-- dashboard-meta:' + JSON.stringify(metadata) + ' -->' + remainingBody;
  }
  let result = issue;
  if (Object.keys(update).length) {
    const response = await fetch(issueUrl, {
      method: 'PATCH', headers, body: JSON.stringify(update),
    });
    result = await response.json();
    if (!response.ok || result.state !== 'closed') throw new Error('需求完成失败，请检查 GitHub 密钥的 Issues 写入权限。');
  }
  return {
    key: target + '#' + number, repo: target, number: Number(number), title: issue.title,
    state: 'closed', updated_at: result.updated_at,
    submitter: typeof metadata.submitter === 'string' ? metadata.submitter.trim() : '',
    completion_summary: typeof completionSummary === 'string' ? completionSummary
      : typeof metadata.completion_summary === 'string' ? metadata.completion_summary.trim().slice(0, 500) : '',
  };
}

function validSummary(value) {
  return value === undefined || (typeof value === 'string' && value.trim().length <= 500);
}

async function completeIssue(request, env, target, number) {
  if (request.headers.get('Origin') !== allowedOrigin) return json(request, { error: '操作来源无效。' }, 403);
  if (!env.GITHUB_TOKEN) return json(request, { error: '需求完成功能尚未配置。' }, 503);
  if (!target.startsWith(repository.split('/')[0] + '/')) return json(request, { error: '不允许操作其他账号的项目。' }, 403);
  const limit = await env.SUBMIT_RATE_LIMIT.limit({ key: 'admin:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!limit.success) return json(request, { error: '操作太频繁，请稍后再试。' }, 429);
  let payload;
  try { payload = await request.json(); } catch { return json(request, { error: '无法读取完成选项，请刷新后重试。' }, 400); }
  if (!validSummary(payload?.completion_summary)) return json(request, { error: '请用不超过 500 字的一两句话说明改好了什么。' }, 400);
  try {
    const completed = await completeRequirement(env, target, number, payload?.completion_summary?.trim());
    let receipt = { notification: 'skipped' };
    if (payload?.notify_submitter === true) {
      try {
        const receipts = await sendCompletionNotifications(env, [completed]);
        receipt = receipts.get(completed.key);
      } catch (error) { receipt = { notification: 'failed', notification_error: error.message || '钉钉通知发送失败。' }; }
    }
    return json(request, { state: completed.state, updated_at: completed.updated_at, ...receipt });
  } catch (error) {
    return json(request, { error: error.message || '需求完成失败，请稍后重试。' }, error.status || 502);
  }
}

async function completeBatch(request, env) {
  if (request.headers.get('Origin') !== allowedOrigin) return json(request, { error: '操作来源无效。' }, 403);
  if (!env.GITHUB_TOKEN) return json(request, { error: '需求完成功能尚未配置。' }, 503);
  if (Number(request.headers.get('Content-Length') || 0) > 65_536) return json(request, { error: '批量完成内容过大，请分批操作。' }, 413);
  let payload;
  try {
    const reader = request.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          return json(request, { error: '批量完成内容过大，请分批操作。' }, 413);
        }
        chunks.push(value);
      }
    }
    payload = JSON.parse(await new Blob(chunks).text());
  } catch { return json(request, { error: '无法读取批量完成选项。' }, 400); }
  if (!Array.isArray(payload?.issues) || !payload.issues.length || payload.issues.length > 10) return json(request, { error: '每次请选择 1 至 10 项需求。' }, 400);
  const seen = new Set();
  for (const entry of payload.issues) {
    if (!entry || typeof entry.repo !== 'string' || !/^chengfengsunce\/[a-zA-Z0-9_.-]+$/.test(entry.repo) || !['number', 'string'].includes(typeof entry.number) || !/^[1-9][0-9]{0,9}$/.test(String(entry.number)) || !validSummary(entry.completion_summary)) {
      return json(request, { error: '需求编号、项目或完成说明无效，每项说明最多 500 字。' }, 400);
    }
    const key = entry.repo + '#' + entry.number;
    if (seen.has(key)) return json(request, { error: '同一需求不能重复选择。' }, 400);
    seen.add(key);
  }
  const limit = await env.SUBMIT_RATE_LIMIT.limit({ key: 'admin:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!limit.success) return json(request, { error: '操作太频繁，请稍后再试。' }, 429);
  const results = [];
  const completed = [];
  for (const entry of payload.issues) {
    try {
      const requirement = await completeRequirement(env, entry.repo, entry.number, entry.completion_summary?.trim());
      completed.push(requirement);
      results.push({ repo: requirement.repo, number: requirement.number, state: requirement.state, updated_at: requirement.updated_at, notification: 'skipped' });
    } catch (error) {
      results.push({ repo: entry.repo, number: Number(entry.number), error: error.message || '需求完成失败。', notification: 'skipped' });
    }
  }
  let notificationCount = 0;
  if (payload.notify_submitter === true && completed.length) {
    try {
      const receipts = await sendCompletionNotifications(env, completed);
      notificationCount = new Set([...receipts.values()].filter(receipt => receipt.notification === 'queued')).size;
      for (const result of results) {
        const receipt = receipts.get(result.repo + '#' + result.number);
        if (receipt) Object.assign(result, receipt);
      }
    } catch (error) {
      for (const result of results) if (result.state === 'closed') Object.assign(result, { notification: 'failed', notification_error: error.message || '钉钉通知发送失败。' });
    }
  }
  return json(request, { results, completed_count: completed.length, failed_count: results.length - completed.length, notification_count: notificationCount });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const issueRoute = url.pathname.match(/^\/api\/issues\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([1-9][0-9]*)$/);
    const draftRoute = url.pathname.match(/^\/api\/issues\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([1-9][0-9]{0,9})\/completion-draft$/);
    const submitterRoute = url.pathname.match(/^\/api\/issues\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([1-9][0-9]{0,9})\/submitter$/);
    if (request.method === 'OPTIONS' && (url.pathname === '/api/issues' || url.pathname === '/api/issues/complete-batch' || issueRoute || draftRoute || submitterRoute)) {
      if (request.headers.get('Origin') !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
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
    if (submitterRoute && ['GET', 'PATCH'].includes(request.method)) return editSubmitter(request, env, submitterRoute[1] + '/' + submitterRoute[2], submitterRoute[3], json);
    if (draftRoute && ['GET', 'PUT'].includes(request.method)) return completionDraft(request, env, draftRoute[1] + '/' + draftRoute[2], draftRoute[3], json);
    if (request.method === 'POST' && url.pathname === '/api/issues/complete-batch') return completeBatch(request, env);
    if (request.method === 'PATCH' && issueRoute) return completeIssue(request, env, issueRoute[1] + '/' + issueRoute[2], issueRoute[3]);
    return json(request, { error: 'Not found' }, 404);
  },
};
