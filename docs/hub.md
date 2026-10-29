# CloudCLI Hub（第一阶段）

Hub 提供 `/cloudcli/` 前端，并按浏览器选中的服务器转发 `/api/`、`/health`、
`/ws`、`/shell`、`/plugin-ws/` 和 `/desktop-notifications`。项目、会话、
文件、终端和 Codex 进程仍由选中的后端管理。切换入口为 `/hub/`；
切换后会重新打开前端。各后端的登录令牌在浏览器中分开保存，首次访问
另一台服务器时需要在该服务器登录。
已打开的页面会在 API、流式请求和 WebSocket 上携带自己的后端 ID，
因此另一个标签页切换服务器时，不会把当前页面的操作发到新选中的后端。

这是按服务器切换整个工作区的第一阶段，不会聚合各后端的项目列表，
也不会跨服务器迁移会话。现有单机服务无须改变或重启。

构建前端时保留子路径：

```sh
npx vite build --base=/cloudcli/
npm run build:server
```

在 Hub 主机准备配置文件，例如 `/etc/cloudcli/hub-backends.json`：

```json
{
  "defaultBackendId": "office",
  "backends": [
    { "id": "office", "name": "OfficeMac", "url": "http://100.64.0.10:3001" },
    { "id": "lab", "name": "Lab Server", "url": "http://100.64.0.11:3001" }
  ]
}
```

后端 URL 必须是内部网络可访问的 HTTP(S) origin，不能带路径或凭据。
后端应只允许 Hub 经 VPN 或防火墙访问，不应直接暴露到公网。

```sh
HUB_BACKENDS_FILE=/etc/cloudcli/hub-backends.json \
HUB_HOST=127.0.0.1 HUB_PORT=3003 npm run hub
```

Hub 默认从当前工作目录的 `dist/` 和 `public/` 读取前端资源；也可设置
`HUB_DIST_DIR`、`HUB_PUBLIC_DIR`。`HUB_BASE_PATH` 默认是 `/cloudcli`。
公网反向代理应将 `/cloudcli/`、`/hub/`、`/api/`、`/health`、`/ws`、
`/shell`、`/plugin-ws/`、`/desktop-notifications` 原样转发到 Hub 的 3003 端口，
并允许 WebSocket Upgrade 和长时间流式连接。不要同时让旧规则绕过 Hub
直达 OfficeMac。
可参考 [Nginx 模板](nginx-hub-template.conf)；替换现有 CloudCLI location 前
应先核对线上配置，当前代码不会自动修改 Nginx 或重启服务。
