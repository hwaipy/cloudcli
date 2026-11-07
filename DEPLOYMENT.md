# CloudCLI production deployment

Public URL: https://ai.hwaipy.cn/cloudcli/

- The built frontend lives on Code at `/home/ubuntu/apps/cloudcli-prod/current`. `cloudcli-prod-frontend.service` serves it on loopback port 33002.
- The backend runs on OfficeMac loopback port 3001 via `scripts/prod-local.py` and LaunchAgent `cn.hwaipy.cloudcli-prod`.
- The production launcher pins `CLOUDCLI_CODEX_TRANSPORT=app-server` (enabled at the user's request on 2026-10-29). Set it to `exec` and restart the backend to return to the SDK transport. Permission approval UI is not yet connected for App Server.
- The backend uses `~/.cloudcli/auth.db`; existing credentials and session data remain in place.
- The existing VM relay and Code loopback port 33001 forward API and WebSocket traffic to the backend.
- On Code, the `nginx` container serves public HTTPS and forwards `/cloudcli/` to `ai-guis-https` port 3001. That proxy routes static frontend requests to 33002 and API/WebSocket requests to 33001.

Proxy configuration on Code:

- `/home/ubuntu/dockers/nginx/conf.d/ai.hwaipy.cn.conf`
- `/home/ubuntu/dockers/ai-guis/nginx.conf`

The former `/cloudcli_debug/` deployment, local Vite service, and its SSH tunnel have been removed. The normal `npm run dev` command remains available for temporary local development, but it does not expose a public development deployment.

The preexisting database and deployment backups under `.debug-local/` have been preserved.

## User-requested deployment policy

When the user requests a deployment, deploy the changed frontend, Hub, and backend automatically. The frontend and Hub may be restarted directly. Backend artifacts should be built and deployed, but the backend process must not be restarted automatically; report that a manual backend restart is needed. This policy persists until the user changes it. The interactive launcher's `B` action still restarts the backend, so do not invoke it during an assistant-managed deployment; build with the production Node toolchain and leave the running process untouched.

## Interactive restart command

On OfficeMac, `reloadCloudCLI` opens a terminal menu. `B` fingerprints backend source/configuration and build outputs, runs `npm run build:server` only when needed using the LaunchAgent's Node, then restarts and health-checks the backend. A failed build does not restart it. `F` similarly builds the frontend with `--base=/cloudcli/` into `.debug-local/frontend-build`, verifies its assets, uploads a new release to Code, atomically switches `current`, and restarts the static server. The remote index and all boot assets are checked against local SHA-256 values; failed activation rolls back to the previous release and verifies it. Identical healthy releases skip upload and restart. Previous releases remain available for rollback.

`H` only restarts the Hub. `L` opens live logs (press `F`/`B` inside the viewer to choose the component). `Q` exits after workers finish. Build receipts and logs are under `.debug-local/`; missing receipts force a first build. Local locks prevent duplicate same-component operations and a remote lock serializes frontend activation. Frontend publishing also requires `scripts/reload-frontend-release.py` beside the launcher. The `~/.local/bin/reloadCloudCLI` symlink works from any working directory. Session-index backfill is a separate maintenance operation, not part of restart or frontend publishing.

## Production frontend build path

Build with `vite build --base=/cloudcli/`. The default Vite base `/` cannot be served at this public subpath. Before release, verify `index.html` points to `/cloudcli/assets/`, and test the actual entry script as well as boot-assets.json.

## 2026-10-29 Steer message reconciliation release

- Frontend release: `/home/ubuntu/apps/cloudcli-prod/releases/20261029T150109Z`.
- Previous release retained for rollback: `/home/ubuntu/apps/cloudcli-prod/releases/20261029T141918Z`.
- Only frontend assets changed. `cloudcli-prod-frontend.service` was restarted because the static server resolves `current` when it starts; the backend was not restarted.
- To roll back on Code, point `current` at the previous release and restart `cloudcli-prod-frontend.service`. Existing browser tabs need a refresh to load either version.
