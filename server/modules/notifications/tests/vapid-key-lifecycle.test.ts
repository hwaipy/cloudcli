import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('VAPID keys follow the active database and reuse its persisted identity across reconnects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-vapid-'));
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(root, 'first.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  const { initializeDatabase, closeConnection, vapidKeysDb } = await import('@/modules/database/index.js');
  await initializeDatabase();
  const { getPublicKey } = await import('@/modules/notifications/vapid-keys.service.js');
  try {
    const first = getPublicKey();
    assert.equal(getPublicKey(), first);
    assert.equal(vapidKeysDb.getVapidKeys()?.publicKey, first);
    closeConnection();
    process.env.DATABASE_PATH = path.join(root, 'second.db');
    await fs.writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const second = getPublicKey();
    assert.notEqual(second, first, 'keys from one database must never leak into another');
    assert.equal(vapidKeysDb.getVapidKeys()?.publicKey, second);
    closeConnection();
    process.env.DATABASE_PATH = path.join(root, 'first.db');
    await initializeDatabase();
    assert.equal(getPublicKey(), first, 'reopening a database must not rotate existing subscriptions');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
