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

## Production frontend build path

Build with `vite build --base=/cloudcli/`. The default Vite base `/` cannot be served at this public subpath. Before release, verify `index.html` points to `/cloudcli/assets/`, and test the actual entry script as well as boot-assets.json.

## 2026-10-29 Steer message reconciliation release

- Frontend release: `/home/ubuntu/apps/cloudcli-prod/releases/20261029T150109Z`.
- Previous release retained for rollback: `/home/ubuntu/apps/cloudcli-prod/releases/20261029T141918Z`.
- Only frontend assets changed. `cloudcli-prod-frontend.service` was restarted because the static server resolves `current` when it starts; the backend was not restarted.
- To roll back on Code, point `current` at the previous release and restart `cloudcli-prod-frontend.service`. Existing browser tabs need a refresh to load either version.
