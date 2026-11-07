import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { ProviderRuntimeWriter } from '@/shared/index.js';

test('real websocket clients receive, reconnect and replay an accepted direct input exactly once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-input-replay-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase(); userDb.createUser('fixture', 'fixture-hash');
  sessionsDb.createAppSession('input-session', 'codex', directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const sockets: WebSocket[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const startBarrier = new Promise<void>(resolve => { started = resolve; });
  let writer!: ProviderRuntimeWriter;
  let runCount = 0;
  server.on('connection', socket => handleChatConnection(socket as never, { user: { id: 1 } } as never, {
    runtime: {
      hasRuntime: () => true,
      getPendingApprovalsForSession: () => [],
      hasBackgroundWork: () => false,
      run: async (_provider: string, _command: string, _options: unknown, output: ProviderRuntimeWriter) => {
        runCount += 1; writer = output; started(); await held;
      },
    } as never,
  }));
  async function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    sockets.push(socket);
    const frames: Array<Record<string, unknown>> = [];
    const listeners = new Set<() => void>();
    socket.on('message', data => { frames.push(JSON.parse(String(data))); for (const listener of listeners) listener(); });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return {
      socket, frames,
      send: (data: unknown) => socket.send(JSON.stringify(data)),
      wait: (predicate: (frame: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Missing fixture frame')); }, 5000);
        const check = () => { const frame = frames.find(predicate); if (frame) { clearTimeout(timer); listeners.delete(check); resolve(frame); } };
        listeners.add(check); check();
      }),
    };
  }
  try {
    const observer = await client();
    observer.send({ type: 'chat.subscribe', sessions: [{ sessionId: 'input-session' }] });
    await observer.wait(frame => frame.kind === 'chat_subscribed');
    const sender = await client();
    const request = { type: 'chat.send', sessionId: 'input-session', clientMessageId: 'request-1', content: 'fixture question' };
    sender.send(request);
    await startBarrier;
    const ack = await sender.wait(frame => frame.kind === 'chat_send_accepted');
    const user = await observer.wait(frame => frame.role === 'user');
    assert.equal(user.id, 'local_request-1');
    assert.equal(ack.userMessageId, user.id);
    assert.equal(sender.frames.filter(frame => frame.role === 'user').length, 1);
    sender.socket.close();
    const fresh = await client();
    fresh.send({ type: 'chat.subscribe', sessions: [{ sessionId: 'input-session', lastSeq: 0 }] });
    const replay = await fresh.wait(frame => frame.role === 'user');
    assert.equal(replay.id, user.id); assert.equal(replay.runId, user.runId);
    // A lost-ACK retry must neither run nor publish the input twice.
    fresh.send(request);
    await fresh.wait(frame => frame.kind === 'chat_send_accepted');
    assert.equal(runCount, 1);
    writer.send({ id: 'fixture-answer', kind: 'text', role: 'assistant', provider: 'codex', sessionId: 'input-session', content: 'fixture response' });
    await Promise.all([
      observer.wait(frame => frame.id === 'fixture-answer'),
      fresh.wait(frame => frame.id === 'fixture-answer'),
    ]);
    assert.equal(fresh.frames.filter(frame => frame.role === 'user').length, 1);
    // Thousands of progress events cannot evict the only copy of the input.
    for (let index = 0; index < 5001; index++) writer.send({ kind: 'status', provider: 'codex', sessionId: 'input-session', text: `fixture-${index}` });
    assert.equal(chatRunRegistry.replayEvents('input-session', 0).filter(frame => frame.role === 'user').length, 1);
    assert.ok(chatRunRegistry.replayEvents('input-session', 0).length <= 5000);
  } finally {
    release();
    for (const socket of sockets) socket.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    chatRunRegistry.clearAll(); connectedClients.clear(); closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
