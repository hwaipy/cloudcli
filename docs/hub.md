# CloudCLI Hub：多后端注册与项目路由

Hub 提供统一的 `/cloudcli/` 前端入口，并聚合已注册后端的项目。项目、会话、文件、终端和 Codex 进程仍由所属后端管理；Hub 按项目归属路由请求。用户只登录 Hub 账户；后端不要求用户再次登录。

Hub 与每台后端使用各自独立的注册 key。Hub 按当前 Hub 用户身份为目标后端签发短时内部断言，后端据此进行界面和 API 层面的用户归属隔离。浏览器的 Hub 登录令牌不会转发给后端，后端注册 key 也不会发送给浏览器。注册 key 只用于对应后端主动连接 Hub；不同后端的 key 不可互换。此机制不隔离同一系统账号下的终端和文件权限。

首次启动 Hub 时，在前端创建第一个 Hub 账户；该账户自动成为管理员。Hub 账户与任何后端的本地账户数据库相互独立，账户列表和凭据由 Hub 保存。

## 后端注册流程

管理员在 CloudCLI 的 **设置 → 后端** 中创建一个后端并设置显示名称。Hub 生成唯一后端 ID 和一次性注册 key。把 key 交给目标服务器的管理员，并配置在该服务器 CloudCLI 服务环境中。Hub 只保存 key 的 SHA-256 摘要，创建或轮换后只显示一次；遗失时可在设置中重新生成。

Hub 主进程需要配置持久 registry 文件。其目录应由 Hub 服务账号拥有且不可被其他普通用户读取：

```sh
sudo install -d -o ubuntu -g ubuntu -m 700 /var/lib/cloudcli-hub
```

在 Hub 的服务环境中设置：

```sh
HUB_BACKENDS_FILE=/etc/cloudcli/hub-backends.json
HUB_REGISTRY_FILE=/var/lib/cloudcli-hub/registered-backends.json
HUB_HOST=127.0.0.1
HUB_PORT=3003
```

`HUB_BACKENDS_FILE` 至少要保留一个静态后端，作为首次部署时的后端配置入口。新建的动态后端则通过设置页创建。静态后端创建注册 key 并配置到后端服务后，后端会主动连接 Hub；只有建立注册连接后，Hub 才会把它标为在线并转发 API 流量。

Hub 账户文件默认位于 `~/.cloudcli/hub-auth.json`，也可通过 `HUB_AUTH_FILE` 指定。请将其限制为 Hub 服务账号可读写，并纳入安全备份；文件包含 Hub JWT 签名密钥与账户密码摘要。

把设置页生成的 ID、名称和 key，以及 Hub 能访问到的后端 URL 配置到后端服务环境：

```sh
CLOUDCLI_HUB_URL='https://ai.hwaipy.cn'
CLOUDCLI_BACKEND_ID='设置页生成的 ID'
CLOUDCLI_BACKEND_NAME='设置页里的名称'
CLOUDCLI_HUB_REGISTRATION_KEY='设置页生成的一次性 key'
CLOUDCLI_BACKEND_URL='http://100.64.0.21:3001'
```

`CLOUDCLI_BACKEND_URL` 必须是 Hub 主机可访问的 HTTP(S) origin，不能包含路径或凭据。Hub 地址和后端地址应通过 HTTPS/WSS 或受保护的 VPN 网络访问。后端启动后会主动连接 Hub 的 `/hub/register/ws`，以指数退避方式自动重连；Hub 通过 WebSocket ping/pong 检测失活连接。断开后该后端会显示离线，且不能被选择路由。注册信息和后端条目持久保留，Hub 重启后仍会显示，直到后端再次连接。

注册 key 是该后端的长期凭据。不要把它放在命令历史、公开日志或源码仓库中；请使用 LaunchAgent、systemd 等服务环境注入。若 key 泄露，在设置页轮换后同步更新对应后端环境并重启该后端服务。轮换后旧 key 立即失效。

## 构建与反向代理

构建前端时保留子路径：

```sh
npx vite build --base=/cloudcli/
npm run build:server
```

Hub 默认从当前工作目录的 `dist/` 和 `public/` 读取前端资源；也可设置 `HUB_DIST_DIR`、`HUB_PUBLIC_DIR`。`HUB_BASE_PATH` 默认是 `/cloudcli`。

公网反向代理应将 `/cloudcli/`、`/hub/`、`/api/`、`/health`、`/ws`、`/shell`、`/plugin-ws/` 和 `/desktop-notifications` 转发到 Hub 的 3003 端口，并允许 WebSocket Upgrade 和长时间流式连接。不要保留绕过 Hub、直接转发到某个后端的旧规则。可参考 [Nginx 模板](nginx-hub-template.conf)。

`/hub/` 页面显示全部静态和已注册后端的在线状态；已注册后端离线时仍保留在列表中，但不可切换。Hub 只聚合可用项目与路由，不复制远端文件或会话，也不提供跨服务器项目迁移。

## 统一工作区账号状态

- 登录与账号偏好由 Hub 保存，偏好端点为 `/hub/auth/preferences`；旧 `/api/user/preferences` 在 Hub 上也映射到该账号存储。排序、语言、外观、侧栏偏好不再读取某个后端数据库。
- 项目、会话、附件、文件、草稿及队列仍归所属后端。资源 API 必须带明确的 backend ID；旧的选择 Cookie 不参与选路，`/hub/select` 已停用。非资源的旧管理接口仅保留部署配置默认后端的兼容路径，不代表切换工作区。
- 聊天与搜索连接分别对每个后端建立。运行中、归档及最近会话列表汇总所有后端；未知会话链接通过身份验证的查询解析归属，不能落到“上次选择”的后端。
- 浏览器镜像以 Hub 用户 ID 隔离。只允许经迁移标记确认的原账号读取旧草稿镜像；冲突缓存单独保留，不覆盖服务端版本。源数据库和旧浏览器键不删除。某个后端离线时，草稿汇总不以空结果覆盖缓存。
- `scripts/migrate-hub-account-state.py` 默认只预检；在停止 Hub 后使用 `--apply` 应用。它核对项目、会话、草稿归属，将 OfficeMac 原偏好作为基线，其他后端只补缺失项。已完成的迁移再次执行不会覆盖之后修改的 Hub 偏好。

管理员可在 **设置 → 后端** 修改每个后端的显示名称与颜色。颜色和名称持久保存在 Hub registry；侧栏项目使用所属后端颜色。改名不改变后端 ID 或注册 key，已有后端保持连接，并可继续用原环境变量中的名称重新注册。
