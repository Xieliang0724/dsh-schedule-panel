# dsh-schedule-panel — 定时任务面板插件（DSH 0.2.1-rc.5）

一个双面（host + client）DSH 插件，在 Web GUI 侧栏新增「定时面板」入口：

- 侧栏新图标（`sidebar.panellist`）+ 主区面板（`main` key `schedule-panel`）
- Host 半部注册 `/schedule-panel/api/*` 路由，服务端聚合：
  - `GET /api/tasks` — 全量任务（schedule/catalog）+ 关联会话标题 + 最近投递
  - `GET /api/next`    — 未来 24h 即将触发的时间线
  - `GET /api/health`  — 面板自检（schedule 服务是否在线）
- Host 订阅 `schedule/changed` / `api-session/*`，变更时通过 SSE
  `GET /api/events` 推送 `changed` / `session` 帧，前端自动刷新。
- 认证复用 Connection 的 `authorizeIndex`（与 WebUI 同一 cookie/token 体系）。

## 文件

- `package.json` — bundle 清单（`dsh.bundle.patch` + `dsh.client`）
- `cordis.patch.yml` — host 行 `schedule-panel`（inject webServer/connection/typertGateway/schedule）
- `lib/index.mjs` — host 半部
- `lib/client.js` — client 半部（React，经 `__ModuleLoader__`）
- `lib/panel.css` — 预留（样式内联在 client.js 中）

## 安装（本机已验证的路径）

```bash
cd ~/.dsh/profiles/web
~/.hermes/tools/node-26.12.1-linux-x64/bin/pnpm add --save-exact "link:/home/alvinxie/小谢/dsh-schedule-panel"
# 然后在 package.json 的 dsh.profile.bundles 里追加 "dsh-schedule-panel"
systemctl --user restart dsh-web
```

卸载：`pnpm remove dsh-schedule-panel` 并把 bundles 里的名字去掉，重启。

## Remote 调用链（host 半部，零新增协议）

```
typertGateway.invoke({ namespace:'schedule', method:'catalog'|'list'|'history'|'delete', args, peer })
typertGateway.stream({ namespace:'session',  method:'follow', ... })   # 会话标题/状态
connection.createPeer({ principal:{kind:'owner'}, interactions:'none' })
connection.authorizeIndex(req,res)                                     # 与 WebUI 同一鉴权
ctx.on('schedule/changed') / ctx.on('api-session/*')                   # 变更推送
```
