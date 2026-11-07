import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-user-map-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('Hub identity gets a stable local owner row without requiring a backend login', async () => {
  await withDatabase(() => {
    const first = userDb.getOrCreateHubUser('hub-user-one', 'alice');
    const again = userDb.getOrCreateHubUser('hub-user-one', 'alice');
    const second = userDb.getOrCreateHubUser('hub-user-two', 'bob');
    assert.equal(first.id, again.id);
    assert.notEqual(first.id, second.id);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM hub_user_mappings').get() as { count: number }).count, 2);
    assert.equal(userDb.getUserById(Number(first.id))?.username, 'hub_hub-user-one');
  });
});

test('existing backend owner with the same Hub username keeps its project ownership identity', async () => {
  await withDatabase(() => {
    const created = getConnection().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('alice', 'legacy-password-hash');
    const mapped = userDb.getOrCreateHubUser('hub-user-one', 'alice');
    assert.equal(Number(mapped.id), Number(created.lastInsertRowid));
    assert.equal(userDb.getOrCreateHubUser('hub-user-one', 'alice').id, mapped.id);
  });
});
