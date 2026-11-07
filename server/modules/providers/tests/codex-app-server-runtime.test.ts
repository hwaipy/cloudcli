import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createCodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

type Event = Record<string, unknown>;

class ScriptedConnection {
  calls: string[] = [];
  callParams: Array<{ method: string; params: unknown }> = [];
  requestHandler?: (id: string | number, method: string, params: unknown) => boolean;
  responses: Array<{ id: string | number; result: unknown }> = [];
  onRequest(handler: (id: string | number, method: string, params: unknown) => boolean): void { this.requestHandler = handler; }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result: JSON.parse(JSON.stringify(result)) }); }
  ask(id: string | number, params: Record<string, unknown> = {}): boolean {
    return this.requestHandler?.(id, 'item/tool/requestUserInput', {
      threadId: 'native-1', turnId: 'turn-1', itemId: 'question-item', isBlocking: true,
      questions: [{ id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'A', description: 'First' }] }], ...params,
    }) ?? false;
  }
  closed = false;
  private listener: ((event: { method?: string; params?: unknown }) => void) | null = null;
  private onClose: ((error: Error) => void) | null = null;

  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push(method);
    this.callParams.push({ method, params });
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
    resolveIsolation: () => null,
    idleMs: 30_000,
    ...options,
  });
  const events: Event[] = [];
  const sessions = new CodexSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requested) => requested || undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (event, sessionId) => sessions.normalizeMessage(event, sessionId),
    isProviderInstalled: async () => true,
  };
  const start = (extra: Record<string, unknown> = {}) => runtime.run('hello', { sessionId: 'app-1', cwd: '/tmp', permissionMode: 'acceptEdits', ...extra }, {
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

test('Codex question RPC is replayable, answers by question ID once, then continues streaming', async () => {
  const { connection, runtime, events, start } = setup();
  const running = start(); await waitForStart(connection);
  assert.equal(connection.ask('rpc-question'), true);
  const pending = runtime.permissions.listPending('app-1') as Array<{ requestId: string; input: unknown }>;
  assert.equal(pending.length, 1);
  assert.equal(runtime.permissions.listPending('another-session').length, 0);
  assert.ok(events.some((event) => event.kind === 'permission_request'));
  runtime.permissions.resolve(pending[0].requestId, { allow: true, updatedInput: { answers: { choice: 'A' } } });
  runtime.permissions.resolve(pending[0].requestId, { allow: true, updatedInput: { answers: { choice: 'B' } } });
  assert.deepEqual(connection.responses, [{ id: 'rpc-question', result: { answers: { choice: { answers: ['A'] } } } }]);
  assert.equal(runtime.permissions.listPending('app-1').length, 0);
  connection.emit('item/completed', { item: { id: 'final-question-answer', type: 'agentMessage', text: 'Continued', phase: 'final_answer' } });
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;
  assert.ok(events.some((event) => event.content === 'Continued'));
  assert.ok(events.some((event) => event.kind === 'permission_resolved'));
  await runtime.shutdownAll();
});

test('non-blocking questions survive completion, native resolution retracts them after the turn', async () => {
  const { connection, runtime, events, start } = setup();
  const running = start(); await waitForStart(connection);
  assert.equal(connection.ask(12, { isBlocking: false }), true);
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;
  assert.equal(runtime.permissions.listPending('app-1').length, 1);
  connection.emit('serverRequest/resolved', { requestId: 12 });
  assert.equal(runtime.permissions.listPending('app-1').length, 0);
  assert.ok(events.some((event) => event.kind === 'permission_cancelled'));
  await runtime.shutdownAll();
});

test('stale, malformed and wrong-thread questions are refused; interrupt cleans pending prompts', async () => {
  const { connection, runtime, start } = setup();
  const running = start(); await waitForStart(connection);
  assert.equal(connection.ask(1, { threadId: 'other' }), false);
  assert.equal(connection.ask(1, { turnId: 'old-turn' }), false);
  assert.equal(connection.ask(1, { questions: null }), false);
  assert.equal(connection.ask(1), true);
  await runtime.abort('app-1');
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  await running;
  assert.equal(runtime.permissions.listPending('app-1').length, 0);
  await runtime.shutdownAll();
});

test('skipping yields empty answers, while secret answers are never echoed into transcript frames', async () => {
  const { connection, runtime, events, start } = setup();
  const running = start(); await waitForStart(connection);
  connection.ask(4);
  let pending = runtime.permissions.listPending('app-1') as Array<{ requestId: string }>;
  runtime.permissions.resolve(pending[0].requestId, { allow: false });
  assert.deepEqual(connection.responses[0].result, { answers: {} });
  connection.ask(5, { questions: [{ id: 'token', header: 'Secret', question: 'Secret?', options: null, isSecret: true }] });
  pending = runtime.permissions.listPending('app-1') as Array<{ requestId: string }>;
  runtime.permissions.resolve(pending[0].requestId, { allow: true, updatedInput: { answers: { token: 'test-sensitive-answer' } } });
  assert.deepEqual(connection.responses[1].result, { answers: { token: { answers: ['test-sensitive-answer'] } } });
  assert.ok(!JSON.stringify(events).includes('test-sensitive-answer'));
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running; await runtime.shutdownAll();
});

test('the plan permission choice selects native Codex Plan collaboration mode', async () => {
  const { connection, runtime, start } = setup();
  const running = start({ permissionMode: 'plan', model: 'gpt-6-luna' });
  await waitForStart(connection);
  const params = connection.callParams.find((call) => call.method === 'turn/start')!.params as { collaborationMode: unknown };
  assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6-luna', reasoning_effort: null, developer_instructions: null } });
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running; await runtime.shutdownAll();
});

test('binds the gateway input to its native turn without duplicating native userMessage items', async () => {
  const { connection, runtime, events, start } = setup();
  const input = { id: 'local_request', kind: 'text', role: 'user', content: 'hello', sessionId: 'app-1', provider: 'codex', timestamp: '2026-11-05T00:00:00Z' };
  const running = start({ acceptedUserMessage: input });
  await waitForStart(connection);
  connection.emit('item/completed', { item: { type: 'userMessage', id: 'native-user', content: [{ type: 'text', text: 'hello' }] } });
  connection.emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await running;
  const inputs = events.filter(event => event.role === 'user');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].id, 'local_request');
  assert.equal(inputs[0].transcriptAnchorId, 'turn-1');
  await runtime.shutdownAll();
});
