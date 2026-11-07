#!/usr/bin/env node
// Isolated real-Codex Plan-mode question round trip. Requires existing auth and a model available to that account.
// Copies only config/auth into a private temporary Codex home; never sends to a production conversation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-question-live-'));
const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexHome = path.join(work, 'codex'); await fs.mkdir(codexHome, { mode: 0o700 });
for (const name of ['config.toml', 'auth.json']) {
  try { await fs.copyFile(path.join(sourceHome, name), path.join(codexHome, name)); await fs.chmod(path.join(codexHome, name), 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.env.CODEX_HOME = codexHome;
process.env.DATABASE_PATH = path.join(work, 'auth.db');
const load = (file) => import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'server', file)).href);
const db = await load('modules/database/index.js'); await db.initializeDatabase();
const { CodexAppServerConnection } = await load('modules/providers/list/codex/codex-app-server-connection.provider.js');
const { createCodexAppServerRuntime } = await load('modules/providers/list/codex/codex-app-server-runtime.provider.js');
const { CodexSessionsProvider } = await load('modules/providers/list/codex/codex-sessions.provider.js');
const model = process.env.ISOLATION_VERIFY_MODEL || 'gpt-6-luna';
let received = 0; const events = [];
const runtime = createCodexAppServerRuntime({ resolveIsolation: () => null, turnTimeoutMs: 120000, createConnection: () => new CodexAppServerConnection() });
try {
  const sessions = new CodexSessionsProvider();
  await runtime.run("This is an isolated integration test. Use request_user_input to ask exactly one question: 'Which color?', with id 'color' and two options Blue and Red. Wait for the response. After receiving the answer reply exactly QUESTION_ROUNDTRIP_OK. Do not use file or shell tools.",
    { sessionId: 'question-integration-test', cwd: work, projectPath: work, model, permissionMode: 'plan' },
    { isWebSocketWriter: true, send: (event) => {
      events.push(event);
      if (event.kind === 'permission_request') {
        received++; console.log('REAL_CODEX_QUESTION_RECEIVED', event.input.questions.length);
        const q = event.input.questions[0];
        queueMicrotask(() => runtime.permissions.resolve(event.requestId, { allow: true, updatedInput: { answers: { [q.id]: 'Blue' } } }));
      }
    } },
    { resolveProviderSessionId: () => null, resolveResumeModel: async () => model, getProviderModels: async () => ({ OPTIONS: [], DEFAULT: model }), normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id), isProviderInstalled: async () => true });
  for (const event of events.filter((event) => event.kind === 'error')) console.log('ERROR',String(event.content).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0,500));
  assert.equal(received, 1);
  assert.ok(events.some((event) => event.kind === 'permission_resolved'));
  assert.ok(events.some((event) => String(event.content).includes('QUESTION_ROUNDTRIP_OK')));
  assert.ok(events.some((event) => event.kind === 'complete' && event.exitCode === 0));
  console.log('REAL_CODEX_QUESTION_ANSWER_CONTINUE_OK');
} finally { await runtime.shutdownAll(); db.closeConnection(); await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
