# Automatic AI session titles

For new CloudCLI conversations, the first message immediately supplies the existing temporary name. A background request then summarizes that first message into a short title in the same language (aiming for 8–16 Chinese characters or 3–6 English words).

- Supported generators: Codex and Claude, using credentials configured on the conversation's backend. Other providers retain the temporary name.
- Codex uses a stateless Responses request with `tools: []`, `tool_choice: none`, and `store: false`. The current selected model is passed at session creation. Older clients use the backend's catalog rather than blindly trusting a stale global model default.
- Claude uses an ephemeral SDK request with no tools, no MCP servers, no plugins or project settings, a deny-all tool callback, and no persisted session.
- Only the first 4,000 characters are supplied; no project files or attachment bodies are read for naming.
- Each request has a 25-second timeout. At most four requests run concurrently per backend. Excess or failed attempts leave the temporary name intact; they are not retried automatically.
- A manual rename cancels a pending title update, even if the user restores the temporary name. The database update also atomically checks that the expected temporary name is unchanged. Deleted sessions are never recreated.
- A successful update broadcasts the existing session ID. It does not create another conversation, change ownership, or update message-ordering timestamps.
- Existing conversations are not backfilled. Backend restarts discard pending title jobs without affecting conversations.

Title generation consumes a small additional inference request. Deploy the frontend and backend artifacts, then manually restart the conversation backends. No schema migration is required.

Verification includes generator request-shape tests, rename/deletion/concurrency regression tests, atomic repository tests, and real Codex/Claude inference on Mac plus Codex inference with the Ubuntu backend's configured API credentials. Probes use synthetic text and do not send messages to existing business sessions.
