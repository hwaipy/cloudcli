import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebSocket } from 'ws';

import { closeConnection, getConnection, initializeDatabase, notificationPreferencesDb } from '@/modules/database/index.js';
import { notifyRunOutcome, registerDesktopNotificationClient, unregisterDesktopNotificationClient } from '@/modules/notifications/index.js';

test('fast turns each deliver; duplicate callbacks collapse by turn and transport IDs never reuse grouping tags', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-notification-turns-'));
  const previous = process.env.DATABASE_PATH; closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const id = Number(getConnection().prepare('INSERT INTO users(username,password_hash) VALUES (?,?)').run('turn-probe', 'fixture-only').lastInsertRowid);
  const prefs = notificationPreferencesDb.getPreferences(id);
  notificationPreferencesDb.updatePreferences(id, { ...prefs, channels: { ...prefs.channels, desktop: true } });
  const frames: Array<{ id: string; payload: { data: { tag: string } } }> = [];
  const socket = { OPEN: 1, readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as unknown as WebSocket;
  registerDesktopNotificationClient({ userId: id, deviceId: 'turn-device', ws: socket });
  try {
    const input = { userId: id, provider: 'codex', sessionId: 'turn-probe-session', outcome: 'completed' as const };
    notifyRunOutcome({ ...input, runId: 'turn-one' });
    notifyRunOutcome({ ...input, runId: 'turn-one' });
    assert.equal(frames.length, 1);
    notifyRunOutcome({ ...input, runId: 'turn-two' });
    assert.equal(frames.length, 2, 'another turn in the same session must not wait twenty seconds');
    assert.equal(frames[0].payload.data.tag, frames[1].payload.data.tag);
    assert.notEqual(frames[0].id, frames[1].id, 'native clients must not mistake the reused grouping tag for event identity');
    notifyRunOutcome({ ...input, runId: 'turn-three', outcome: 'failed', error: 'fixture failure' });
    notifyRunOutcome({ ...input, runId: 'turn-four', outcome: 'failed', error: 'fixture failure' });
    assert.equal(frames.length, 4, 'identical failures from distinct turns must both deliver');
    notifyRunOutcome({ ...input, outcome: 'failed' });
    notifyRunOutcome({ ...input, outcome: 'failed' });
    assert.equal(frames.length, 6, 'separate startup failures have no native turn yet');
  } finally {
    unregisterDesktopNotificationClient(socket); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
