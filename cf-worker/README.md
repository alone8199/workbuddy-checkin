# WB 签到 - Cloudflare Worker 版

把原 Node 版签到（wb-checkin-server + wb-panel + cron）搬到 Cloudflare Workers：
无服务器、免运维，用 Cron Triggers 每日自动签到，KV 存日志，自带 Web 面板。

## 与原版的对应关系

| 原文件 | Worker 版 |
|---|---|
| wb-checkin-server.cjs | src/checkin.js（签到核心逻辑） |
| wb-panel.cjs | src/worker.js 的 fetch handler + 内嵌面板 |
| wb-checkin-random.sh / cron | wrangler.toml 的 Cron Triggers |
| checkin.log | Workers KV（LOGS 命名空间） |
| credentials.json | Secret `CREDENTIALS` |
| wb-export-token.cjs / decrypt-auth.cjs / wb-inspect.mjs | **保留在本地**，依赖本机文件系统和 Electron 客户端，无法上云 |

## 部署步骤

1. 安装依赖：
   ```
   cd cf-worker
   npm install
   ```

2. 登录 Cloudflare：
   ```
   npx wrangler login
   ```

3. 创建 KV 命名空间存日志：
   ```
   npx wrangler kv namespace create LOGS
   ```
   把输出里的 `id` 填到 wrangler.toml 的 `[[kv_namespaces]]` 下的 `id`。

4. 配置凭据（内容同 credentials.json）：
   ```
   npx wrangler secret put CREDENTIALS
   ```
   粘贴：
   ```json
   {"uid":"你的uid","accessToken":"你的token","domain":"www.workbuddy.cn"}
   ```

5. （可选）面板不设鉴权；如需保护，建议在 Cloudflare 控制台给这个 Worker 套 Access 策略，
   而不是在代码里加密钥。

6. 部署：
   ```
   npm run deploy
   ```

7. 本地调试（可选）：
   ```
   npm run dev
   ```
   注意 `wrangler dev` 默认不会真正执行 Cron，可访问面板手动触发签到测试。
   用 `npm run tail` 实时查看线上日志。

## 使用

部署后直接访问 `https://wb-checkin.<你的子域>.workers.dev/` 打开面板（无需密钥）。
面板内容：积分余额与各额度分组、连续签到 / 活动累计 / 今日获得、凭据剩余天数进度条、
当月签到日历（金色=已签到）、覆盖率与最长连续、签到记录 / 统计 / 运行日志三个标签页、手动立即签到。

## 定时说明

- Cron `0 22 * * *`（UTC）= 北京时间每天 06:00 触发。
- Worker 触发后做 0~5 秒短随机延迟。原 shell 的 0~60 分钟长延迟在 Workers 里不适用
  （CPU 时间和执行时长有限制），如需更分散可改 worker.js 里的延迟或加多条 cron。
- 签到接口本身幂等（服务端按天去重），即使多触发也不会重复加分。

## token 过期

Worker 里的 token 与本地 credentials.json 同源，会过期。过期后面板会显示「凭据已过期」，
此时在本地重新跑 `node wb-export-token.cjs` 导出新 token，再用 `npx wrangler secret put CREDENTIALS`
更新云端凭据即可。日志里也会记录 AUTH 过期事件。

## 安全提示

- accessToken 等同账号凭证，务必设置 PANEL_KEY，或给 Worker 套 Cloudflare Access。
- 不要把 CREDENTIALS 写进 wrangler.toml 或提交到 git。
