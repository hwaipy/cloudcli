# Isolated development

Use Node.js 24, install dependencies with `npm ci`, then run `npm run dev:isolated`.
Optionally set `CLOUDCLI_DEBUG_NODE` to an absolute Node.js executable.

- UI and Vite hot reload: http://localhost:3002/cloudcli_debug/ (also listens on the LAN).
- API with automatic restart: http://127.0.0.1:3102.
- Node debugger: 127.0.0.1:9232, available through Chrome's `chrome://inspect`.
- Private runtime files: `.debug-local/`, excluded from Git.

The development processes use `.debug-local/home` as their own home directory.
CloudCLI accounts, provider configuration, sessions, assets and discovery markers
are independent of the existing installation. Create a new CloudCLI account on
first visit, then authenticate the providers you want to use. Files you explicitly
open or edit in a shared project still affect that project.

Do not run the ordinary `npm run dev` if you need this isolation.

On this Mac the service is managed by the LaunchAgent `cn.hwaipy.cloudcli-debug`:

```sh
launchctl kickstart -k gui/$(id -u)/cn.hwaipy.cloudcli-debug
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/cn.hwaipy.cloudcli-debug.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/cn.hwaipy.cloudcli-debug.plist
```

Logs are in `.debug-local/stdout.log` and `.debug-local/stderr.log`.
The original CloudCLI service and its launcher remain separate.

## HTTPS proxy on Code

Public development URL: https://ai.hwaipy.cn/cloudcli_debug/

The macOS LaunchAgent `cn.hwaipy.cloudcli-debug-tunnel` forwards Code's loopback
ports 3002 and 9232 to this Mac. On Code, the host-network `ai-guis-https` nginx
container bridges Docker-only `172.17.0.1:33002` to loopback port 3002. The main
`nginx` container forwards only `/cloudcli_debug/` to that bridge.

The isolated launcher enables Vite's `/cloudcli_debug/` base. Its debug-only
bootstrap prefixes API and WebSocket requests and browser storage keys, and
registers a non-caching service worker scoped to that path. The production
`/cloudcli` routing and root API remain unchanged. The debugger is still only
available through SSH, without a public nginx route.

Validation: `node --test scripts/debug-proxy-client.test.mjs`.
