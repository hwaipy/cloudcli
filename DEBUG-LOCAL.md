# CloudCLI development service

This checkout replaces the former npm-installed standard CloudCLI.

- Main URL: https://ai.hwaipy.cn/cloudcli/
- Local URL: http://127.0.0.1:3001/cloudcli/
- API: http://127.0.0.1:3102 (loopback only).
- Node inspector: 127.0.0.1:9232, local access only.
- Vite hot reload and backend automatic restart remain enabled.

The service uses the real macOS home directory for provider authentication,
configuration and historical sessions. Changes to sessions or provider settings
are shared with the local command-line tools. Codex subagent transcripts are
excluded from the sidebar by the upstream application. The 13 existing Codex
archived transcripts were imported separately and retain their archived status.

The merged CloudCLI database is `.debug-local/auth.db`. It retains the account
created for the development instance and imports the former standard instance's
projects, session index and related metadata. Migration backups are stored under
`.debug-local/merge-backup-*`. All runtime data is excluded from Git.

## Operation

The LaunchAgent `cn.hwaipy.cloudcli-debug` runs `scripts/dev-local.py` using the
separate Node.js 24 runtime installed on this Mac.

```sh
launchctl kickstart -k gui/$(id -u)/cn.hwaipy.cloudcli-debug
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/cn.hwaipy.cloudcli-debug.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/cn.hwaipy.cloudcli-debug.plist
```

For foreground development, stop the LaunchAgent first, then run:

```sh
CLOUDCLI_DEBUG_NODE="$HOME/.local/share/cloudcli-debug-runtime/node_modules/node/bin/node" npm run dev:local
```

Logs: `.debug-local/stdout.log` and `.debug-local/stderr.log`.

## Reverse proxy

The existing 3001 relay and Code's 33001 transport now serve this development
instance. Code's HTTPS nginx forwards `/cloudcli/` without removing the prefix.
The `/cloudcli_debug/` endpoint returns 404. Port 3002 and its SSH reverse forward,
and the temporary Docker bridge on 33002, have been removed.

The `cn.hwaipy.cloudcli-debug-tunnel` LaunchAgent has been stopped and removed.
Port 9232 is no longer forwarded to Code. There is no public nginx route for it.

The Vite bootstrap prefixes API/WebSocket requests, preserves the development
browser-storage namespace, and uses a non-caching service worker scoped to
`/cloudcli/`. It never replaces the root-scoped service worker.

Validation: `node --test scripts/debug-proxy-client.test.mjs`.
