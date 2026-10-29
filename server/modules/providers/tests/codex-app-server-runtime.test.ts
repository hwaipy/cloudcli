import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createCodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

type Event = Record<string, unknown>;

class ScriptedConnection {
  calls: string[] = [];
  closed = false;
  private listener: ((event: { method?: string; params?: unknown }) => void) | null = null;
  private onClose: ((error: Error) => void) | null = null;

  async call(method: string): Promise<unknown> {
    this.calls.push(method);
    if (method === 'thread/start') return { thread: { id: 'native-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method: ${method}`);
  }

  subscribe(listener: (event: { method?: string; params?: unknown }) => void, onClose: (error: Error) => void): () => void {
    this.listener = listener;
    this.onClose = onClose;
    return () => { this.listener = null; this.onClose = null; };
  }

  emit(method: string, params: Record<string, unknown>): void {
    this.listener?.({ method, params: { threadId: 'native-1', turnId: 'turn-1', ...params } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(new Error('closed'));
  }
}

function setup(options: { turnTimeoutMs?: number; interruptGraceMs?: number } = {}) {
  const connection = new ScriptedConnection();
  const runtime = createCodexAppServerRuntime({
    createConnection: () => connection as never,
    idleMs: 30_000,
    ...options,
  });
  const events: Event[] = [];
  const sessions = new CodexSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (event, sessionId) => sessions.normalizeMessage(event, sessionId),
    isProviderInstalled: async () => true,
  };
  const start = () => runtime.run('hello', { sessionId: 'app-1', cwd: '/tmp', permissionMode: 'acceptEdits' }, {
    isWebSocketWriter: true,
    send: (event) => events.push(event as Event),
  }, context);
  return { connection, runtime, events, start };
}

async function waitForStart(connection: ScriptedConnection): Promise<void> {
  for (let attempt = 0; attempt < 30 && !connection.calls.includes('turn/start'); attempt += 1) {
    await delay(1);
  }
  assert.ok(connection.calls.includes('turn/start'));
}

test('App Server deltas replace one message and retain final-answer phase', async () => {
  const { connection, runtime, events, start } = setup();
  const running = start();
  await waitForStart(connection);
  connection.emit('item/started', { item: { type: 'agentMessage', id: 'answer-1', text: '', phase: 'final_answer' } });
  connection.emit('item/agentMessage/delta', { itemId: 'answer-1', delta: 'Hel' });
  connection.emit('item/agentMessage/delta', { itemId: 'answer-1', delta: 'lo' });
  connection.emit('item/completed', { item: { type: 'agentMessage', id: 'answer-1', text: 'Hello', phase: 'final_answer' } });
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;
  const answers = events.filter((event) => event.id === 'answer-1');
  assert.deepEqual(answers.map((event) => event.content), ['Hel', 'Hello', 'Hello']);
  assert.ok(answers.every((event) => event.codexPhase === 'final_answer'));
  assert.ok(events.some((event) => event.kind === 'complete' && event.exitCode === 0));
  await runtime.shutdownAll();
  assert.equal(connection.closed, true);
});

test('App Server streams cumulative token usage for the active session and turn', async () => {
  const { connection, runtime, events, start } = setup();
  const running = start();
  await waitForStart(connection);
  const tokenUsage = {
    total: { totalTokens: 157_123_456 },
    last: { inputTokens: 40_525, outputTokens: 170 },
    modelContextWindow: 258_400,
  };
  connection.emit('thread/tokenUsage/updated', { tokenUsage });
  connection.emit('thread/tokenUsage/updated', { turnId: 'another-turn', tokenUsage });
  connection.emit('thread/tokenUsage/updated', {
    tokenUsage: { ...tokenUsage, total: { totalTokens: 157_124_456 } },
  });
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;

  const budgets = events.filter((event) => event.kind === 'status' && event.text === 'token_budget');
  assert.equal(budgets.length, 2);
  assert.equal(budgets[1].sessionId, 'app-1');
  assert.deepEqual(budgets[0].tokenBudget, {
    used: 40_695,
    contextUsed: 40_695,
    total: 258_400,
    sessionTotalTokens: 157_123_456,
    inputTokens: 40_525,
    outputTokens: 170,
    breakdown: { input: 40_525, output: 170 },
  });
  assert.equal((budgets[1].tokenBudget as { sessionTotalTokens: number }).sessionTotalTokens, 157_124_456);
  await runtime.shutdownAll();
});

test('a configured App Server turn limit reports the limit and releases its child', async () => {
  const { connection, events, start } = setup({ turnTimeoutMs: 20 });
  await start();
  assert.equal(connection.closed, true);
  assert.ok(events.some((event) => event.kind === 'error' && String(event.content).includes('configured running limit (20 ms)')));
  assert.ok(events.some((event) => event.kind === 'complete' && event.exitCode === 1));
});

test('a turn with no duration limit keeps running until App Server completes it', async () => {
  const { connection, runtime, events, start } = setup({ turnTimeoutMs: 0 });
  const running = start();
  await waitForStart(connection);
  let settled = false;
  void running.then(() => { settled = true; });

  await delay(40);
  assert.equal(settled, false);
  assert.equal(connection.closed, false);
  assert.equal(events.some((event) => event.kind === 'error'), false);

  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;
  assert.ok(events.some((event) => event.kind === 'complete' && event.exitCode === 0));
  await runtime.shutdownAll();
});

test('accepted interrupt without completion releases its child after grace period', async () => {
  const { connection, runtime, start } = setup({ interruptGraceMs: 20 });
  const running = start();
  await waitForStart(connection);
  assert.equal(await runtime.abort('app-1'), true);
  await running;
  assert.equal(connection.closed, true);
  assert.ok(connection.calls.includes('turn/interrupt'));
});

test('runtime shutdown interrupts and closes an active App Server child', async () => {
  const { connection, runtime, start } = setup();
  const running = start();
  await waitForStart(connection);
  await runtime.shutdownAll();
  await running;
  assert.equal(connection.closed, true);
  assert.ok(connection.calls.includes('turn/interrupt'));
});
