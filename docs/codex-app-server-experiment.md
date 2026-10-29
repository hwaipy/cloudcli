# Codex App Server experiment

CloudCLI continues to use its existing Codex SDK (`codex exec`) path by default. The persistent App Server transport is opt-in. For a local test isolated from the production port and database, start the backend with the Node 24 runtime that matches this checkout's native SQLite module:

```sh
NODE_ENV=development HOST=127.0.0.1 SERVER_PORT=33101 \
  DATABASE_PATH=/tmp/cloudcli-app-server-test.db \
  CLOUDCLI_CODEX_TRANSPORT=app-server \
  npx -y node@24 node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json server/index.ts
```

In another terminal, run the matching local frontend:

```sh
HOST=127.0.0.1 SERVER_PORT=33101 VITE_PORT=53101 npm run client
```

The frontend and backend must run from this source revision. When the backend reports App Server mode, a **Steer** button appears beside Send while a Codex turn is active and the composer contains text. Send still queues a separate follow-up message. Steer appends text to the active turn. App Server agent-message and command-output deltas flow through the existing transcript normalization path.

The App Server process is scoped to one CloudCLI session, reused across its turns, and closed after ten idle minutes. Existing native Codex threads are resumed by their stored thread ID. A failed connection or turn ends that run with an error; it does not silently retry a potentially destructive prompt. The normal Stop button interrupts the active App Server turn. If no completion follows an accepted interrupt, its child is released after five seconds. A turn with no completion for 30 minutes fails and releases the child. Backend shutdown also closes all held App Server connections.

To return to the existing behavior, stop the temporary processes. Unsetting `CLOUDCLI_CODEX_TRANSPORT` (or setting it to `exec`) on a later launch selects the original SDK path. This does not migrate production session data. **Do not enable the flag in production until the experiment is validated there.** This change does not deploy or restart the production service.

Current limit: App Server permission requests are declined because CloudCLI's existing permission dialog is not connected to that protocol yet. Ordinary workspace-write turns also disable sandbox network access. Use a separate temporary project for the first interactive trial, and verify resumption, queueing, disconnects and any required approval flow before using this transport for normal work.
