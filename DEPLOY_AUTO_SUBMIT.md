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

## 标记需求完成

进行中的需求行显示“完成”，管理员点击后在弹窗临时输入 `ADMIN_TOKEN` 并确认。页面通过 `PATCH /api/issues/<owner>/<repo>/<number>` 请求 Worker；缺少密钥、密钥错误、非本站来源或其他账号的仓库均不能修改状态。管理员密钥不会写入网页、同步数据或浏览器存储，关闭弹窗即清空。

Worker 将原 GitHub Issue 的状态更新为 `closed`，原因设为 `completed`。成功后需求立即从“进行中”移入“已完成”，同步更新完成数量和完成率；“全部”中仍能查看，已完成行不再显示操作按钮。不会删除需求、隐藏需求，也不会覆盖原标签、正文和图片。旧版删除接口已取消。

浏览器只暂存成功完成的需求编号和 GitHub 更新时间，避免旧同步数据把它退回进行中；下一次同步到已完成状态后清除暂存。若在 GitHub 将需求重新打开，较新的状态会正常恢复为进行中。

`issueApiBaseUrl` 仍为 `ACCOUNT_SUBDOMAIN` 占位地址时，新增和完成都会明确提示“通道还未部署”，不会发送提交内容或管理员密钥，也不会假装修改成功。推送 GitHub Pages 不等于部署 Worker；新增或修改 Worker 后必须重新执行上面的发布步骤。
