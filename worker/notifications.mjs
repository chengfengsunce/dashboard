function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}\[\]()<>#+!|~-]/g, character => '\\' + character);
}

function paragraphs(text) {
  return escapeMarkdown(text).split(/\r?\n+|(?<=[。！？])(?=\S)/u).filter(Boolean).join('<br><br>');
}

async function deliverGroup(env, headers, userId, entries, capabilities) {
  const multiple = entries.length > 1;
  const title = multiple ? `本次完成 ${entries.length} 项需求` : `已完成｜${entries[0].title}`;
  const content = multiple
    ? entries.map((entry, index) => `${index + 1}. ${entry.title}\n${entry.completion_summary || '这项需求已经处理完成。'}`).join('\n\n')
    : entries[0].completion_summary || '这项需求已经处理完成。';
  const markdown = multiple
    ? [`<font sizeToken=common_h2_text_style__font_size>${title}</font>`, ...entries.map((entry, index) => `🔷 **${index + 1}. ${escapeMarkdown(entry.title)}**<br><br>${paragraphs(entry.completion_summary || '这项需求已经处理完成。')}`)].join('<br><br>')
    : [`<font sizeToken=common_h2_text_style__font_size>${escapeMarkdown(entries[0].title)}</font>`, '🔷 **改好了什么**', paragraphs(content)].join('<br><br>');
  let warning;
  if (capabilities.cardUnavailable) {
    warning = '尚未开通互动卡片实例写权限（Card.Instance.Write），本次已用文字发送。';
  } else if (new TextEncoder().encode(markdown).length <= 1024 && new TextEncoder().encode(title).length <= 1024) {
    const response = await fetch('https://api.dingtalk.com/v1.0/card/instances/createAndDeliver', {
      method: 'POST', headers,
      body: JSON.stringify({
        cardTemplateId: env.DINGTALK_CARD_TEMPLATE_ID || '589420e2-c1e2-46ef-a5ed-b8728e654da9.schema',
        outTrackId: 'dashboard_completion_' + crypto.randomUUID(),
        cardData: { cardParamMap: { title: multiple ? `✅ 已完成 ${entries.length} 项需求` : '✅ 需求已完成', markdown } },
        imRobotOpenSpaceModel: {
          supportForward: true,
          lastMessageI18n: { ZH_CN: title },
          notification: { alertContent: title, notificationOff: false },
        },
        openSpaceId: 'dtv1.card//IM_ROBOT.' + userId,
        imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode: env.DINGTALK_ROBOT_CODE },
        userIdType: 1,
      }),
    });
    const card = await response.json();
    if (response.ok && card.success === true) {
      const deliveries = card.result?.deliverResults;
      if (!Array.isArray(deliveries) || deliveries.length !== 1 || deliveries[0].spaceType !== 'IM_ROBOT' || deliveries[0].spaceId !== userId || deliveries[0].success !== true) {
        throw new Error('钉钉卡片尚未确认投放成功，请检查机器人状态后重试。');
      }
      return { notification: 'queued', notification_format: 'card' };
    }
    if (response.status === 403 && card.code === 'Forbidden.AccessDenied.AccessTokenPermissionDenied' && card.accessdenieddetail?.requiredScopes?.includes('Card.Instance.Write')) {
      capabilities.cardUnavailable = true;
      warning = '尚未开通互动卡片实例写权限（Card.Instance.Write），本次已用文字发送。';
    } else {
      throw new Error(`钉钉卡片发送失败${typeof card.code === 'string' ? `（${card.code}）` : ''}，请检查卡片模板和机器人配置。`);
    }
  } else {
    warning = '完成说明超出卡片长度限制，本次已合并为一条文字完整发送。';
  }
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST', headers,
    body: JSON.stringify({ robotCode: env.DINGTALK_ROBOT_CODE, userIds: [userId], msgKey: 'sampleText', msgParam: JSON.stringify({ content: `${title}\n\n${content}` }) }),
  });
  const result = await response.json();
  if (!response.ok || !result.processQueryKey) throw new Error('钉钉机器人未接受通知，请检查消息长度、机器人编码和消息发送权限。');
  if (result.invalidStaffIdList?.length || result.filteredStaffIdList?.length) throw new Error('钉钉机器人无法通知该提出人，请检查应用可用范围和接收人账号。');
  if (result.flowControlledStaffIdList?.length) throw new Error('钉钉通知触发限流，请稍后重试。');
  return { notification: 'queued', notification_format: 'text', notification_warning: warning };
}

export async function sendCompletionNotifications(env, entries) {
  const receipts = new Map();
  const byName = new Map();
  for (const entry of entries) {
    if (!entry.submitter) {
      receipts.set(entry.key, { notification: 'failed', notification_error: '需求中未填写提出人，无法发送钉钉通知。' });
      continue;
    }
    if (!byName.has(entry.submitter)) byName.set(entry.submitter, []);
    byName.get(entry.submitter).push(entry);
  }
  if (!byName.size) return receipts;
  if (!env.DINGTALK_APP_KEY || !env.DINGTALK_SECRET || !env.DINGTALK_ROBOT_CODE) throw new Error('钉钉应用通知尚未配置完整。');
  const tokenResponse = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: env.DINGTALK_APP_KEY, appSecret: env.DINGTALK_SECRET }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.accessToken) throw new Error('钉钉应用认证失败，请检查 Client ID 和 Client Secret。');
  const headers = { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token.accessToken };
  const byUser = new Map();
  for (const [name, requirements] of byName) {
    try {
      const response = await fetch('https://api.dingtalk.com/v1.0/contact/users/search', {
        method: 'POST', headers, body: JSON.stringify({ queryWord: name, offset: 0, size: 20 }),
      });
      const search = await response.json();
      if (!response.ok) throw new Error('无法查找提出人，请检查通讯录搜索权限和可见范围。');
      const matches = [...new Set(search.list || [])];
      if (search.hasMore || matches.length > 1) throw new Error(`钉钉中有多位“${name}”，请填写完整姓名后重试。`);
      if (matches.length !== 1 || typeof matches[0] !== 'string') throw new Error(`未找到钉钉成员“${name}”，请检查姓名和通讯录可见范围。`);
      if (!byUser.has(matches[0])) byUser.set(matches[0], []);
      byUser.get(matches[0]).push(...requirements);
    } catch (error) {
      for (const entry of requirements) receipts.set(entry.key, { notification: 'failed', notification_error: error.message || '无法确认钉钉收件人。' });
    }
  }
  const capabilities = { cardUnavailable: false };
  for (const [userId, requirements] of byUser) {
    let receipt;
    try {
      receipt = await deliverGroup(env, headers, userId, requirements, capabilities);
    } catch (error) {
      receipt = { notification: 'failed', notification_error: error instanceof TypeError || error instanceof SyntaxError ? '钉钉通知结果未确认，请先核对消息，再手动重试。' : error.message || '钉钉通知发送失败。' };
    }
    for (const entry of requirements) receipts.set(entry.key, receipt);
  }
  return receipts;
}
