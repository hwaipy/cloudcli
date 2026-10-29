import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudCLI message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('migration merges a provider-keyed duplicate into the app session and enforces one mapping', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createAppSession('app-id', 'codex', '/workspace/demo', 'Chosen name');
    sessionsDb.assignProviderSessionId('app-id', 'native-id');

    // Reproduce a database merge that imported an app row beside an indexed row.
    db.exec('DROP INDEX idx_sessions_provider_native_unique');
    db.prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path)
      VALUES (?, 'codex', ?, ?, ?, ?)
    `).run('native-id', 'native-id', 'Indexed name', '/workspace/demo', '/transcripts/native-id.jsonl');
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(1, 'test-user', 'hash');
    db.prepare('INSERT INTO session_drafts (user_id, draft_scope, draft_text) VALUES (?, ?, ?)')
      .run(1, 'native-id', 'Unsent draft');
    db.prepare(`
      INSERT INTO scheduled_messages (id, user_id, session_id, content, scheduled_for)
      VALUES (?, ?, ?, ?, ?)
    `).run('scheduled-1', 1, 'native-id', 'Later message', '2026-10-29T10:00:00.000Z');

    runMigrations(db);

    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(sessionsDb.getSessionByProviderSessionId('native-id')?.session_id, 'app-id');
    assert.equal(sessionsDb.getSessionById('app-id')?.custom_name, 'Chosen name');
    assert.equal(sessionsDb.getSessionById('app-id')?.jsonl_path, '/transcripts/native-id.jsonl');
    const draft = db.prepare('SELECT draft_text FROM session_drafts WHERE draft_scope = ?')
      .get('app-id') as { draft_text: string } | undefined;
    const scheduled = db.prepare('SELECT session_id FROM scheduled_messages WHERE id = ?')
      .get('scheduled-1') as { session_id: string } | undefined;
    assert.equal(draft?.draft_text, 'Unsent draft');
    assert.equal(scheduled?.session_id, 'app-id');
    assert.throws(() => db.prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
      VALUES (?, 'codex', ?, ?)
    `).run('another-id', 'native-id', '/workspace/demo'));
  });
});

test('running migrations again leaves a new app session unmapped until the provider starts', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-id', 'codex', '/workspace/demo');
    runMigrations(getConnection());
    assert.equal(sessionsDb.getSessionById('pending-id')?.provider_session_id, null);
  });
});
