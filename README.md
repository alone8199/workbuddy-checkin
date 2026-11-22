# 微博签到（wb-checkin）

- 本地路径: D:\projects\261115-0751-微博签到
- 建立日期: 2026-11-15（原目录名 wb-checkin，2026-11-21 改名规范化）
- 状态: 可用，已跑通连续签到

## 定位

微博超话/日常签到自动化：用已登录的 accessToken 调签到接口，附带纯 Node 的 Web 面板做状态查询、手动触发、日志查看。线上实例部署在西安服 `/opt/wb-checkin/`，由 cron 每日随机延迟 0~60 分钟后执行。

## 文件结构

| 文件 | 说明 |
|---|---|
| wb-checkin-server.cjs | 签到主程序，读写 checkin.log |
| wb-panel.cjs | Web 面板（无第三方依赖）：`/api/status`、`/api/checkin`、`/api/logs`，鉴权走 `?key=` 或 `X-Key` 头，端口 `WB_PANEL_PORT`（默认 7777） |
| wb-checkin-random.sh | 服务器 cron 入口：随机 sleep 0~3600 秒后执行签到 |
| wb-inspect.mjs | 调试：查看账号/超话状态 |
| wb-export-token.cjs | 从浏览器导出 token 到 credentials.json |
| decrypt-auth.cjs | 解密本地浏览器保存的认证信息 |
| credentials.json | 账号凭据（uid + accessToken，含隐私，勿外传） |
| checkin.log | 签到结果日志 |

## 运行

```
node wb-checkin-server.cjs              # 单次签到
WB_PANEL_PORT=7777 node wb-panel.cjs    # 起面板
```

## 备注

- 面板 key 默认由 uid + token 前 32 位哈希派生，可用 `WB_PANEL_KEY` 覆盖
- token 会过期，过期后用 wb-export-token.cjs 重新导出
- 最近一次记录：2026-11-15 连续 11 天，总积分 1100
