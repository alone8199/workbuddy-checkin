# WorkBuddy 每日签到

给 [WorkBuddy](https://www.workbuddy.cn) 用的每日自动签到工具：到点自己签到、积分自己算清楚，还给一个能随时打开看的工作台面板。

不用装服务器，整套东西跑在 Cloudflare Workers 上——免费额度够用，一次部署，之后基本不用管。

```
浏览器打开面板  →  看余额、看签到日历、看记录
每天 06:00     →  Worker 自动签到，结果写进日志
```

---

## 它解决什么问题

- **总是忘记签到**：每天定时自动完成，连续天数不会断。
- **不知道攒了多少分**：面板直接显示余额、各额度分组、活动累计、今日获得。
- **想确认到底签没签**：日历年历一眼看出哪几天漏了，还有覆盖率与最长连续。
- **出问题看不到原因**：签到记录 / 统计 / 运行日志三个标签页，失败原因写得很清楚。
- **token 过期没提示**：凭据剩余天数做成进度条，快过期变红。

## 面板长什么样

打开 Worker 域名就是面板，无需登录、无需密钥。从上到下四块：

| 区域 | 内容 |
|---|---|
| 顶部 | 积分余额大数字 + 各额度分组（平台奖励 / 套餐基础 / 套餐赠送 / 购买积分） |
| 右上 | 今日状态（已签到 / 待签到 / 活动未开启 / 凭据过期）+ **立即签到** 按钮 + 上次与下次执行时间 |
| 指标条 | 连续签到、活动累计、今日获得、凭据剩余（带进度条） |
| 签到日历 | 月历热力图，已签到高亮，未来日期虚线；`‹ 2026年11月 ›` 可往前翻 24 个月；右侧显示本月签到 / 覆盖率 / 最长连续 |
| 底部标签页 | 签到记录、统计、运行日志 |

## 快速开始

### 0. 你需要准备

- 一个 Cloudflare 账号（免费版即可）
- 一份 WorkBuddy 账号凭据：`uid` + `accessToken`

凭据从本机已登录的 WorkBuddy 客户端导出，脚本在本仓库根目录：

```bash
node wb-export-token.cjs      # 生成 credentials.json
```

脚本会自己找到 WorkBuddy 装在哪，不用改代码：先看 `--exe` 参数、`WORKBUDDY_EXE` 环境变量、上次成功的缓存，再问运行中的进程、注册表卸载项，最后退到常见目录和浅层磁盘扫描。

```bash
node wb-export-token.cjs --find                        # 只打印定位到的路径，不碰客户端
node wb-export-token.cjs --exe "D:\WB\WorkBuddy\WorkBuddy.exe"   # 实在找不到就手动指定
```

> 运行前先退出 WorkBuddy：脚本会关掉它，再以 `--inspect` 重启来读取 token，导出完成后客户端保持运行。

内容形如：

```json
{ "uid": "你的uid", "accessToken": "你的token", "domain": "www.workbuddy.cn" }
```

> `accessToken` 等同于账号密码，不要提交到任何仓库、不要发到群里。本仓库的 `.gitignore` 已经屏蔽了 `credentials.json`。

### 1. 克隆并安装

```bash
git clone https://github.com/alone8199/workbuddy-checkin.git
cd workbuddy-checkin/cf-worker
npm install
```

### 2. 建日志仓库（KV）

```bash
npx wrangler login          # 浏览器授权一次
npx wrangler kv namespace create LOGS
```

把输出里的 `id` 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "LOGS"
id = "刚刚拿到的 id"
```

### 3. 写入凭据

```bash
npx wrangler secret put CREDENTIALS
```

粘贴刚才那份 JSON，回车。凭据存在 Cloudflare 的 Secret 里，不进代码、不进仓库。

### 4. 部署

```bash
npm run deploy
```

终端会打印你的面板地址，形如 `https://wb-checkin.<你的子域>.workers.dev/`，打开就能用。

## 日常使用

- **什么都不用做**：每天北京时间 06:00 自动签到（Cron `0 22 * * *` UTC），结果写入日志。
- **想手动补签**：打开面板点「立即签到」。接口本身按天去重，多点几次也不会重复加分。
- **看历史**：日历往前翻月；「签到记录」保留最近 30 条，「运行日志」保留最近 200 行。

## 常见问题

**面板显示「凭据已过期」**
`accessToken` 到期了。在本机重新跑 `node wb-export-token.cjs`，再执行一次 `npx wrangler secret put CREDENTIALS` 覆盖旧值即可，不用重新部署。

**余额显示 0 或「连接失败」**
先确认 `CREDENTIALS` 里的 `uid` / `accessToken` 没写错、`domain` 是 `www.workbuddy.cn`。凭据没问题的话，多半是请求被上游拦了——本项目的请求都带浏览器 User-Agent，若你改动过 `checkin.js` 的请求头，注意别把它删掉。

**定时任务没跑**
`wrangler.toml` 里的 `[triggers] crons` 是否还在，部署后用 `npm run tail` 看实时日志。KV 里还没有记录时，面板会显示「暂无签到记录，等待首次自动签到」，这是正常的。

**能改签到时间吗**
改 `wrangler.toml` 里的 cron 表达式，注意它用 **UTC**：`0 22 * * *` = 北京 06:00，`0 0 * * *` = 北京 08:00。

**面板能加密码吗**
面板本身不设鉴权（方便随时打开）。如果不想公开，推荐在 Cloudflare 控制台给这个 Worker 套一层 **Cloudflare Access**，而不是在代码里加密钥。

## 本地开发

```bash
cd cf-worker
npm run dev      # 本地起 Worker，wrangler dev 不会真跑 cron，用面板按钮触发签到
npm run tail     # 看线上实时日志
```

想在没有网络/凭据的情况下调界面，可以用 `node make-preview.js` 生成 `preview.html`——它注入模拟数据，纯静态，浏览器直接打开。

## 目录结构

```
.
├── cf-worker/                 Cloudflare Worker 版（推荐）
│   ├── src/worker.js          入口：路由 + 内嵌面板（HTML/CSS/JS）
│   ├── src/checkin.js         签到与查询核心逻辑
│   ├── wrangler.toml          KV 绑定、Cron、兼容日期
│   ├── make-preview.js        生成带模拟数据的本地预览
│   └── README.md              开发者视角的部署/迁移说明
├── wb-checkin-server.cjs      Node 版签到主程序（单次执行）
├── wb-panel.cjs               Node 版面板（端口 7777，?key= 鉴权）
├── wb-checkin-random.sh       服务器 cron 入口：随机延迟 0~60 分钟后执行
├── wb-export-token.cjs        从本机客户端导出 accessToken（自动定位安装目录）
├── decrypt-auth.cjs           解密本地保存的认证信息
└── wb-inspect.mjs             调试：查看账号与活动状态
```

Node 版适合有常开服务器的场景：

```bash
node wb-checkin-server.cjs                 # 执行一次签到
WB_PANEL_PORT=7777 node wb-panel.cjs       # 起面板
```

## 数据与隐私

- 云端只存两样东西：**凭据**（Worker Secret）和**签到日志**（KV，最近 200 行）。
- 日志里有签到时间与积分变化，没有密码、没有 cookie。
- 仓库里不含任何凭据文件；`.workbuddy/`、`.wrangler/`、`*.log` 也都在忽略列表里。
- 想彻底清除：`npx wrangler delete` 删 Worker，再删掉 KV 命名空间。

## 说明

个人自用的自动化小工具，接口行为随上游变化，不保证长期可用。请遵守 WorkBuddy 的服务条款，不要用于批量、多账号等滥用场景。
