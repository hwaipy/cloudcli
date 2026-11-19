# Claude Code in CloudCLI

Claude conversations run on the project's assigned backend through the Claude Agent SDK and that host's Claude Code executable. They use the host's credentials; logging into the Hub does not log into Anthropic.

## Use on the Mac backend

1. Install Claude Code and run `claude auth login` as the backend's system user. `claude auth status` should report the official account.
2. Create a new conversation in a non-isolated Mac project. Open its model picker and choose a model from the Claude group. Existing Codex conversations keep their provider; create a separate conversation to use Claude.
3. Settings → Agents → Claude → Account shows authentication and CLI version. Settings → Plan usage groups the registered backends and their installed providers; official Claude logins show the plan and five-hour/weekly usage for that specific host, refreshed every minute while the panel is open.
4. A backend restart is required after deploying server changes. Follow the project convention: the operator restarts the conversation backend manually.

The authentication reader supports the default macOS `Claude Code-credentials` Keychain item and Linux/file credentials. A custom `CLAUDE_CONFIG_DIR` reads its own files without falling back to the default macOS account. Authentication responses and quota responses never expose access or refresh tokens.

API-key credentials and third-party endpoints remain supported by the existing runtime, but do not display the saved official account's quota as though it were API billing. API credentials override the subscription and the account panel warns when a valid subscription is being bypassed. Quota failure is shown as unavailable, not zero usage.

After moving from a third-party endpoint to official authentication, remove its old `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` mappings as well as its URL/token. Otherwise a Claude alias can still resolve to the third party's model. Restart processes that inherited old environment variables.

## Isolation boundary

Strict project containers currently support Codex only. Claude is available in non-isolated projects; this change does not pass Mac credentials to Ubuntu or bypass strict container filesystem restrictions.

## Verification

The implementation was checked using keychain/file-auth and quota cache/error regression tests, frontend quota tests, and two live isolated probes: a Claude SDK Write/Read round-trip in a temporary directory, and a CloudCLI runtime turn producing normalized text/status/completion events. Neither probe sent messages to an existing business conversation. The local official OAuth quota read also succeeded.

## Backend-scoped new-conversation models

Chat requests `/api/providers/:provider/available-models` from the project's assigned Hub backend. That endpoint only returns the backend's configured catalog when the provider CLI is installed and authenticated. The editable model-library endpoint remains separate so an operator can configure a provider before installing/signing into it. Custom model entries are explicit backend configuration, not proof of upstream entitlement to every model.

On a backend change, chat hides the previous catalog immediately and ignores late replies from the previous host. Failed discovery does not reuse another host's models. Strict projects further restrict choices to Codex. A new conversation cannot send until its selected model occurs in the confirmed catalog; existing conversations retain their original provider/model identity.

After deploying this API, restart each conversation backend manually and refresh the frontend. A backend running an older build fails closed for new model discovery rather than showing an unverified static fallback catalog.

## Versioned Claude labels

The Claude adapter reads `supportedModels()` through the installed CLI's Agent SDK control channel without yielding a user prompt. It disables transcript persistence and project/user setting hooks for discovery, closes the query in `finally`, bounds the request to ten seconds, coalesces concurrent reads and caches a successful catalog for one minute. Labels use the CLI's version-bearing description or resolved model identifier; requests retain the CLI's original `value` aliases. Only the reported native choices and reasoning levels are used. Discovery failures remain errors rather than guessed versions or a static fallback catalog.
