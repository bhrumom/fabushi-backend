# Cloudflare 后端与前端分离说明

当前部署拆成两个 Cloudflare Worker：

- `web/wrangler.toml`: 旧 Worker 项目，继续承载后端 API 和旧项目内已绑定的 secrets。
- `web/wrangler-web.toml`: 新 Worker 项目，只托管 Flutter Web 静态前端。

## 后端部署

在 `web` 目录执行：

```bash
npx wrangler deploy --env production
```

验证：

```bash
curl https://api.ombhrum.com/health
```

后端 Worker 只挂：

```text
api.ombhrum.com/*
```

## 前端部署

先在仓库根目录构建 Flutter Web：

```bash
flutter build web --release --dart-define=API_BASE_URL=https://api.ombhrum.com
```

然后在 `web` 目录执行：

```bash
npx wrangler deploy --config wrangler-web.toml --env production
```

前端 Worker 只挂：

```text
flutter.ombhrum.com/*
```

## 前端配置

Flutter 前端通过 `AppConfig.currentBackendUrl` 调用后端，生产默认后端为：

```text
https://api.ombhrum.com
```

如果需要临时指向其他后端，可在构建前端时传入：

```bash
flutter build web --release --dart-define=API_BASE_URL=https://api.ombhrum.com
```

## 域名职责

- `api.ombhrum.com`: 旧 Cloudflare Worker 项目上的 API、R2 代理、WebSocket 在线人数。
- `flutter.ombhrum.com`: 新 Cloudflare Worker 项目上的 Flutter Web 静态站点、隐私政策和支持页面。

后端 Worker 不再托管 `/index.html`、`/main.dart.js`、`/privacy`、`/support` 等前端页面；未命中的非 API 路径会返回 JSON 404。前端 Worker 不处理 `/api/*`、`/r2`、`/health` 等后端路径。
