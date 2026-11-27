# 自动提交和完成需求

首次部署需要 Cloudflare Workers 和一个 GitHub 精细化访问令牌；令牌只存 Worker Secret，不放入公开网页。

1. 在 GitHub 创建精细化访问令牌，至少选择 `chengfengsunce/dashboard` 并授予 `Issues: Read and write`。如需完成其他项目的原有需求，也要将对应仓库加入令牌授权范围。
2. 安装 Wrangler 并登录 Cloudflare：`npx wrangler login`。
3. 创建图片桶：`npx wrangler r2 bucket create dashboard-issue-images`。
4. 安全写入 GitHub 令牌：`npx wrangler secret put GITHUB_TOKEN`。
5. 配置管理员密钥：`npx wrangler secret put ADMIN_TOKEN`，输入独立的高强度随机密钥，不要使用 GitHub 令牌代替。
6. 发布接口：`npx wrangler deploy`，将输出中的 Worker 地址填到 `index.html` 的 `issueApiBaseUrl`，然后提交并推送网页。

看板只接受来自 `https://chengfengsunce.github.io` 的表单请求；接口每个来源 IP 每分钟最多接收 3 次提交，并拒绝填写隐藏网站字段的机器人。需求由令牌所属账号创建；最多附 4 张 JPG、PNG、GIF 或 WebP 图片（每张不超过 2 MB）。

## 需求字段

新增表单选择所属项目、填写提出人；需求仍统一保存到 `chengfengsunce/dashboard` 的 Issues，正文第一行以 `dashboard-meta` 元数据保存项目和提出人。时间使用 GitHub 创建时间，不使用同步时间；旧记录没有元数据时，所属项目用原仓库、提出人用原 GitHub 作者账号，缺少时间则显示“时间未知”。

提交成功后立即更新需求列表；定时同步和手动刷新均保留这些字段。列表按所选项目和状态筛选，每页 10 条，编号为筛选结果的连续序号，点击需求标题可打开 GitHub 原始记录。

## 修改提出人

需求列表中的提出人姓名支持点击编辑，进行中和已完成需求均可修改。弹窗先读取当前姓名，确认后点击“保存”或按Enter；取消或Esc不会保存。保存失败保留输入，需求发生其他变更时提示重新读取，防止旧页面覆盖后来修改。保存成功立即更新列表，刷新页面仍保留；旧静态快照尚未同步时，用本机保存记录暂存新姓名，源数据更新后清除暂存。

修改只保存到原GitHub Issue的 `dashboard-meta.submitter`，不更改需求状态、标题、正文、附件、完成说明或其他元数据，也不发送通知。原完成通知流程每次从Issue读取提出人，因此使用修改后的姓名。括号说明不会自动拆分或猜测；需要通知时填写可在钉钉查到的真实姓名。

接口为 `GET /api/issues/<owner>/<repo>/<number>/submitter` 和 `PATCH` 同一路由。读取返回姓名及 `revision`，保存接受 `{ "submitter": "姓名", "revision": "刚读到的版本" }`。版本使用原更新时间、正文和状态的SHA-256摘要，版本不同返回409；相同姓名可重复确认而不重复写入。姓名需非空、最多60字，不允许尖括号与换行，请求上限4KiB。沿用本站来源、当前账号仓库范围及既有 `DRAFT_RATE_LIMIT` 绑定，编辑与草稿使用不同限流键，不消耗完成操作限额。公开看板的访问方式保持原规则。

## 标记需求完成

进行中的需求行显示“完成”，点击后在弹窗确认，可填写“改好了什么”并选择是否通知提出人，不再输入管理员密码。完成说明选填，最多 500 字，建议用一两句话说明以前的问题和现在能怎么用。页面通过 `PATCH /api/issues/<owner>/<repo>/<number>` 请求 Worker，请求体中的 `completion_summary` 保存到需求元数据，原正文和图片保留；旧调用不传此字段仍然可用。非本站来源或其他账号的仓库均不能修改状态。看板公开且免密，任何访客都能提交完成操作；来源检查和限流不能替代身份认证。

Worker 将原 GitHub Issue 的状态更新为 `closed`，原因设为 `completed`。成功后需求立即从“进行中”移入“已完成”，同步更新完成数量和完成率；“全部”中仍能查看，已完成行不再显示操作按钮。不会删除需求、隐藏需求，也不会覆盖原标签、正文和图片。旧版删除接口已取消。

浏览器只暂存成功完成的需求编号和 GitHub 更新时间，避免旧同步数据把它退回进行中；下一次同步到已完成状态后清除暂存。若在 GitHub 将需求重新打开，较新的状态会正常恢复为进行中。

`issueApiBaseUrl` 仍为 `ACCOUNT_SUBDOMAIN` 占位地址时，新增和完成都会明确提示“通道还未部署”，不会发送提交内容，也不会假装修改成功。推送 GitHub Pages 不等于部署 Worker；新增或修改 Worker 后必须重新执行上面的发布步骤。

## 完成说明自动填充与保存

“改好了什么”现在按真实仓库与Issue编号独立保存草稿。弹窗打开时自动读取已经写入的实际处理结果；输入立即备份到本机，停顿约1.2秒、离开输入框或关闭弹窗时同步到服务端。重新打开、刷新页面或换设备会读取服务端草稿，批量弹窗也逐项恢复。

输入框下方显示“草稿已保存”才表示服务端已接受。网络失败时说明保留在本机，并显示重试入口；无法使用本机存储时会明确提示未保存。另一处已经修改说明时保留当前输入，提示核对后再选择“保存当前说明”。弹窗打开期间每20秒检查服务端新结果，人工有未同步修改时不覆盖输入。

草稿接口只修改 `dashboard-meta.completion_draft`、`completion_draft_revision` 和 `completion_draft_updated_at`，保留原正文、截图、其他元数据和需求状态。保存草稿不会完成需求或发送钉钉消息；“确认完成”继续由处理人决定。

自动化完成开发与验证后，可保存实际结果供弹窗自动填充：

```powershell
python scripts/save_completion_draft.py --issue "chengfengsunce/dashboard#7" --summary-file "完成说明.txt" --expected-title "终端用户手动录入体验优化：支持简称下拉、选中全称带出系统名"
```

说明文件使用UTF-8、最多500字；标题核对可防止误用表格行号，脚本保存后会回读验证内容与状态。只填写实际验证过的结果，未发布应注明“尚未上线”；不得从标题编造完成说明。脚本不关闭需求、不发通知，不使用或保存任何管理员凭据。

接口为 `GET /api/issues/<owner>/<repo>/<number>/completion-draft` 和 `PUT` 同一路由，仍沿用本站来源及当前账号仓库限制。`GET` 返回 `title`、`state`、`completion_summary`、`revision` 和草稿更新时间；`PUT` 接受 `{ "completion_summary": "实际说明", "revision": "刚读到的版本" }`，成功返回新版本。版本不同返回409及当前服务端草稿；重复保存相同内容不重复修改GitHub。读写共用独立 `DRAFT_RATE_LIMIT` 绑定，每个来源每分钟60次，不消耗原需求完成限额。

部署需同时发布 Worker、前端 `completion-drafts.mjs` 和更新后的 `index.html`；`scripts/sync_github.py` 同步保留草稿字段。草稿存放在原公开Issue元数据内，访问范围与需求一致，不能在其中填写凭据或不适合公开的信息。

## 多选完成与合并通知

需求编号旁可勾选进行中的需求，表头复选框全选本页。选择在翻页时保留，每批最多 10 项；切换状态会清空选择，变更项目筛选后会移除已不在范围内的选择。选中后点击“批量完成并通知”，在弹窗逐项填写可选的完成说明，也可取消通知只完成需求。

网页一次调用 `POST /api/issues/complete-batch`，请求体示例：

```json
{
  "issues": [
    {"repo": "chengfengsunce/dashboard", "number": 1, "completion_summary": "导出时会带上当前筛选的记录。"},
    {"repo": "chengfengsunce/dashboard", "number": 2, "completion_summary": "统计会算上当天新增的任务。"}
  ],
  "notify_submitter": true
}
```

每次请求最多 64 KiB，单项说明最多 500 字，只允许当前账号的项目，重复需求和无效参数在修改任何状态前拒绝。整批只计一次完成操作限流，不是每项各计一次。服务器从原始 GitHub 需求读取提出人，并按解析后的钉钉用户账号分组：同一个人收到一条合并通知，不同的人只收到各自需求。浏览器不能指定或覆盖收件人。

响应的 `results` 逐项包含仓库、编号、完成状态、更新时间和通知结果；`completed_count`、`failed_count` 统计需求完成结果，`notification_count` 统计已被钉钉接受的合并消息数量。只把成功完成的需求放入通知。部分需求完成失败时保留原状态；通知失败不撤销已完成状态。弹窗保留每项结果，“重试未成功项”只提交完成失败或通知失败的需求，已成功通知的需求不会重复发送。

合并卡片逐项展示标题和完成说明；超过现有卡片字段字节限制时改用一条完整文字通知，不拆分或截断。若文字也超出钉钉限制，显示通知失败，处理人可缩短说明后重试。网络异常导致结果未确认时先核对需求状态与钉钉消息，再手动重试。

## 钉钉私聊通知

在 Worker Secrets 中配置 `DINGTALK_APP_KEY`（Client ID / AppKey）、`DINGTALK_SECRET`（Client Secret）和 `DINGTALK_ROBOT_CODE`（机器人编码）。不使用群机器人签名，也不能把 AppKey 当成 access token；Worker 每次通知时用应用凭证换取 access token。凭证仅存放在 Worker Secrets，不能提交到 Git 或前端。

应用需开通通讯录搜索权限 `qyapi_addresslist_search` 和机器人消息发送权限 `qyapi_robot_sendmsg`，并将提出人纳入通讯录可见范围和应用可用范围。权限或能力调整后，按钉钉开放平台提示发布版本使其生效。

Worker 从 GitHub 需求元数据读取姓名，只有搜索结果包含唯一一个 `userid` 时才发送机器人单聊消息；结果不唯一时不发送。当前不调用成员信息读取接口，因此无需为通知额外开通 `qyapi_get_member`。

通知优先使用钉钉原生卡片，只展示标题和实际完成说明，不附项目名、详情链接或按钮。例如：

卡片区分层级：顶部绿色“✅ 需求已完成”状态、较大字号需求标题、蓝色“🔷 改好了什么”标签及分段正文。现有模板在实际客户端忽略了文字颜色 Token，因此使用已验证的彩色标识、字号 Token 和 `<br><br>` 间距；沿用 `Card.Instance.Write` 权限，不新增 AI 卡片或模板管理权限。

```text
已完成｜通知内容看不懂

以前要点开链接才能看进展。现在通知会直接说清楚哪件事做好了，以及改好了什么。
```

完成说明只使用处理人填写的内容，不根据需求标题猜实现细节；没有说明时正文为“这项需求已经处理完成。”。建议用两到四句日常用语说明以前的问题、已经完成的改动、现在能怎样使用，不放内部代码名和调试信息。通知重试沿用已保存的说明，不重复关闭需求。

卡片通过 `POST /v1.0/card/instances/createAndDeliver` 投放至同一机器人的单聊会话。应用还需开通 `Card.Instance.Write`（互动卡片实例写权限）并按平台提示发布。默认使用现有官方 Markdown 模板 `589420e2-c1e2-46ef-a5ed-b8728e654da9.schema`，可通过 `DINGTALK_CARD_TEMPLATE_ID` 指定已经发布且有 `title`、`markdown` 变量的模板。

接口通过 `notification_format` 区分 `card` 和 `text`。只有目标投放结果明确成功才返回卡片通知已提交。卡片写权限尚未生效时继续用文字发送，并通过 `notification_warning` 明确原因；完成说明超过卡片每字段 1KB 限制时也使用文字完整发送，不截断正文。网络异常、投放失败或结果不明确时不自动改发第二条消息，避免重复通知。

需求完成与通知结果分别返回。通知失败不撤销已完成状态，弹窗显示具体原因并允许重试；重试不会重复关闭需求。钉钉接口接受消息后显示“通知已提交”，不将接口接受等同于已读或已送达。
