import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A session's turn ends while its agents, workflow or backgrounded command are
 * still going. The run registry marks the run completed at the turn's
 * `complete`, but the runtime keeps producing events through that run's
 * writer — task progress, and the turn the CLI pushes when the task reports.
 * A tab opened during that work has to attach to the run to see them, and the
 * run has to still be there to attach to.
 */

const SESSION_ID = 'held-session';
const FIVE_MINUTES = 5 * 60 * 1000;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-subscribe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    chatRunRegistry.setRetentionGuard(() => false);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Starts a run for the session and ends its turn, leaving the run completed but registered. */
function startAndCompleteRun(connection: ReturnType<typeof createFakeSocket>) {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: 'native-1',
    connection: connection as never,
    userId: 1,
  });
  assert.ok(run);
  run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
  assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  return run;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a tab that subscribes during background work receives the run\'s later events', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: (sessionId: string) => sessionId === SESSION_ID, getPendingApprovalsForSession: () => [] } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    // Not processing — the composer stays usable — but attached.
    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.isProcessing, false);

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(
      newTab.frames.some((frame) => frame.kind === 'task_status'),
      'the task event must reach the tab that subscribed after the turn ended',
    );
  });
});

test('a tab that subscribes to an idle session is not attached to its old run', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(!newTab.frames.some((frame) => frame.kind === 'task_status'));
  });
});

test('a completed run stays registered while its session still has background work', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      startAndCompleteRun(createFakeSocket());

      mock.timers.tick(FIVE_MINUTES);
      assert.ok(chatRunRegistry.getRun(SESSION_ID), 'the run must outlive the retention window while work is outstanding');

      working = false;
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'once the work is gone the run is evicted as before');
    });
  } finally {
    mock.timers.reset();
  }
});

test('a retained run\'s eviction timer cannot evict the session\'s next run early', async () => {
  // Run one completes with work outstanding and is re-armed at five minutes;
  // run two takes the slot and completes with two minutes of retention to
  // go. Run one's timer firing on the slot alone would evict run two.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      const first = startAndCompleteRun(createFakeSocket());
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), first);

      working = false;
      mock.timers.tick(FIVE_MINUTES - 2 * 60 * 1000);
      const second = startAndCompleteRun(createFakeSocket());
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second);

      // Run one's re-armed timer fires now; run two's has two minutes left.
      mock.timers.tick(2 * 60 * 1000);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second, 'run two keeps its own retention window');
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    });
  } finally {
    mock.timers.reset();
  }
});


test('a previously subscribed tab sees a detached queued turn as a user message', async () => {
  await withIsolatedDatabase(async () => {
    const tab = createFakeSocket();
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
      run: async (_provider: string, _command: string, _options: unknown, writer: { send: (message: unknown) => void }) => {
        writer.send({ kind: 'text', role: 'assistant', provider: 'claude', sessionId: SESSION_ID, content: 'done' });
        writer.send({ kind: 'complete', provider: 'claude', sessionId: SESSION_ID, exitCode: 0 });
      },
    } as never;
    handleChatConnection(tab as never, { user: { id: 1 } } as never, { runtime });
    tab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'queued request' }, { runtime },
    );
    assert.equal(result.started, true);
    const userFrame = tab.frames.find((frame) => frame.kind === 'text' && frame.role === 'user');
    assert.equal(userFrame?.content, 'queued request');
    assert.match(String(userFrame?.id), /^local_/);
    assert.ok(tab.frames.some((frame) => frame.kind === 'text' && frame.role === 'assistant'));
    tab.emit('close');
  });
});

test('steering a live Codex turn acknowledges and publishes the accepted text', async () => {
  await withIsolatedDatabase(async () => {
    const tab = createFakeSocket();
    const calls: unknown[] = [];
    const runtime = {
      steer: async (...args: unknown[]) => { calls.push(args); return true; },
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
    } as never;
    handleChatConnection(tab as never, { user: { id: 1 } } as never, { runtime });
    chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'codex', providerSessionId: null, connection: tab as never, userId: 1 });
    tab.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'steer-1', content: 'change direction' }));
    await settle();
    assert.deepEqual(calls, [['codex', SESSION_ID, 'change direction']]);
    assert.ok(tab.frames.some((frame) => frame.kind === 'text' && frame.role === 'user' && frame.content === 'change direction'));
    assert.ok(tab.frames.some((frame) => frame.kind === 'chat_steer_accepted' && frame.clientMessageId === 'steer-1'));
  });
});

test('steering a queued turn takes exactly that item and restores it when refused', async () => {
  await withIsolatedDatabase(async () => {
    getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'hash');
    const first = sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'first', attachments: [] });
    const second = sessionDraftsDb.appendQueuedMessage(1, SESSION_ID, { content: 'second', attachments: [] });
    const tab = createFakeSocket();
    let accept = false;
    const calls: string[] = [];
    const runtime = {
      steer: async (_provider: string, _sessionId: string, text: string) => { calls.push(text); return accept; },
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
    } as never;
    handleChatConnection(tab as never, { user: { id: 1 } } as never, { runtime });
    chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'codex', providerSessionId: null, connection: tab as never, userId: 1 });

    tab.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'refuse', queuedMessageId: second.queuedMessage.id, content: 'forged' }));
    await settle();
    assert.deepEqual(calls, ['second']);
    assert.ok(tab.frames.some((frame) => frame.kind === 'protocol_error' && frame.clientMessageId === 'refuse'));
    assert.deepEqual((sessionDraftsDb.getDrafts(1)[0]?.queuedMessage as Array<{ content: string }>).map((item) => item.content), ['first', 'second']);

    accept = true;
    tab.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, clientMessageId: 'accept', queuedMessageId: first.queuedMessage.id }));
    await settle();
    assert.deepEqual(calls, ['second', 'first']);
    assert.ok(tab.frames.some((frame) => frame.kind === 'chat_steer_accepted' && frame.clientMessageId === 'accept'));
    assert.deepEqual((sessionDraftsDb.getDrafts(1)[0]?.queuedMessage as Array<{ content: string }>).map((item) => item.content), ['second']);
  });
});
