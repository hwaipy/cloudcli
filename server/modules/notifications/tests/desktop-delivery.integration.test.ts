import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { closeConnection, getConnection, initializeDatabase, notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
import { createNotificationEvent, notifyUserIfEnabled, sendDesktopNotification } from '@/modules/notifications/index.js';

test('real notification sockets deliver to the registered owner and honor per-device disable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-desktop-delivery-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db'); await initializeDatabase();
  const insert = getConnection().prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)');
  const owner = Number(insert.run('notification-owner', 'fixture-only').lastInsertRowid);
  const other = Number(insert.run('notification-other', 'fixture-only').lastInsertRowid);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    const user = new URL(request.url || '/', 'http://fixture').searchParams.get('user');
    handleDesktopNotificationsConnection(socket, { ...request, user: { id: Number(user) } } as unknown as Parameters<typeof handleDesktopNotificationsConnection>[1]);
  });
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const clients: WebSocket[] = [];
  const connect = async (user: number) => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/?user=${user}`); clients.push(client);
    const messages: any[] = []; client.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(client, 'open'); const registered = once(client, 'message');
    client.send(JSON.stringify({ type: 'register', deviceId: `fixture-${user}` })); await registered;
    return { client, messages };
  };
  try {
    const a = await connect(owner); const b = await connect(other);
    const prefs = notificationPreferencesDb.getPreferences(owner);
    notificationPreferencesDb.updatePreferences(owner, { ...prefs, channels: { ...prefs.channels, desktop: true } });
    const delivered = once(a.client, 'message');
    notifyUserIfEnabled({ userId: owner, event: { ...createNotificationEvent({ provider: 'codex', kind: 'stop', code: 'run.stopped' }), sessionId: 'notification-session', dedupeKey: 'fixture-owned-completion' } });
    const [raw] = await delivered; const frame = JSON.parse(String(raw));
    assert.equal(frame.type, 'notification'); assert.equal(frame.payload.data.sessionId, 'notification-session');
    const barrier = once(b.client, 'pong'); b.client.ping(); await barrier;
    assert.equal(b.messages.filter(message => message.type === 'notification').length, 0);
    notificationChannelEndpointsDb.setEndpointEnabled(owner, 'desktop', `fixture-${owner}`, false);
    assert.equal(sendDesktopNotification(owner, frame.payload).sent, 0);
  } finally {
    for (const client of clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
