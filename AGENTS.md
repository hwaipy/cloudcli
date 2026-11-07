# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Production deployment preference

When the user asks to deploy CloudCLI changes, deploy the relevant frontend, Hub, and backend artifacts automatically. The frontend and Hub may be restarted as part of deployment. Build and deploy backend changes, but never restart the backend automatically; tell the user that a manual backend restart is required. This preference persists unless the user explicitly changes it.
