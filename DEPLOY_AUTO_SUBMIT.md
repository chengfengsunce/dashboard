# 自动提交需求

首次部署需要 Cloudflare Workers 和一个 GitHub 精细化访问令牌；令牌只存 Worker Secret，不放入公开网页。

1. 在 GitHub 为 `chengfengsunce/dashboard` 创建精细化访问令牌，只授予 `Issues: Read and write`。
2. 安装 Wrangler 并登录 Cloudflare：`npx wrangler login`。
3. 创建图片桶：`npx wrangler r2 bucket create dashboard-issue-images`。
4. 安全写入 GitHub 令牌：`npx wrangler secret put GITHUB_TOKEN`。
5. 发布接口：`npx wrangler deploy`。
6. 将部署输出中的 Worker 地址填到 `index.html` 的 `issueApiBaseUrl`，然后提交并推送网页。

看板只接受来自 `https://chengfengsunce.github.io` 的表单请求；接口每个来源 IP 每分钟最多接收 3 次提交，并拒绝填写隐藏网站字段的机器人。需求由令牌所属账号创建；最多附 4 张 JPG、PNG、GIF 或 WebP 图片（每张不超过 2 MB）。
