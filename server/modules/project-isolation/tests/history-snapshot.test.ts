import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { isolationHistoryManifestScript, isolationHistoryFileScript, parseIsolationHistoryManifest, publishIsolationHistorySnapshot } from '@/modules/project-isolation/history-snapshot.service.js';

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'isolation-snapshot-'));
process.env.DATABASE_PATH = path.join(root, 'auth.db');
process.env.CLOUDCLI_ISOLATION_STATE_DIR = path.join(root, 'state');
await fs.writeFile(process.env.DATABASE_PATH, '');
const { initializeDatabase, closeConnection, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
await initializeDatabase();
const { sessionSynchronizerService, sessionsService } = await import('@/modules/providers/index.js');
after(async () => { closeConnection(); await fs.rm(root, { recursive: true, force: true }); });

test('unchanged snapshots retain their inode and mtime; changed snapshots receive the source timestamp', async () => {
  const home = path.join(root, 'publisher');
  const item = { path: 'sessions/thread.jsonl', data: Buffer.from('original\n').toString('base64'), mtimeMs: Date.parse('2026-01-01T00:00:00Z') };
  assert.equal(await publishIsolationHistorySnapshot(home, item), true);
  const target = path.join(home, item.path);
  const first = await fs.stat(target);
  assert.equal(first.mtimeMs, item.mtimeMs);
  assert.equal(await publishIsolationHistorySnapshot(home, { ...item, mtimeMs: Date.now() }), false);
  const second = await fs.stat(target);
  assert.equal(second.ino, first.ino);
  assert.equal(second.mtimeMs, first.mtimeMs);
  const changed = { ...item, data: Buffer.from('new user activity\n').toString('base64'), mtimeMs: item.mtimeMs + 10_000 };
  assert.equal(await publishIsolationHistorySnapshot(home, changed), true);
  assert.equal((await fs.stat(target)).mtimeMs, changed.mtimeMs);
  assert.equal(await fs.readFile(target, 'utf8'), 'new user activity\n');
});

test('an archived isolated session stays archived when another session publishes history and the watcher reindexes both', async () => {
  const projectPath = path.join(root, 'workspace');
  await fs.mkdir(projectPath);
  const project = projectsDb.createProjectPath(projectPath, 'Strict snapshots', undefined, true).project;
  assert.ok(project);
  const home = path.join(process.env.CLOUDCLI_ISOLATION_STATE_DIR!, project.project_id, 'codex');
  const id = randomUUID();
  const item = { path: `sessions/2026/11/02/rollout-2026-11-02T00-00-00-${id}.jsonl`, data: Buffer.from(JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id, cwd: projectPath } }) + '\n').toString('base64'), mtimeMs: Date.parse('2026-01-01T00:00:00Z') };
  await publishIsolationHistorySnapshot(home, item);
  const indexed = await sessionSynchronizerService.synchronizeProviderFile('codex', path.join(home, item.path));
  assert.equal(indexed.indexed, true);
  await sessionsService.deleteOrArchiveSessionById(indexed.sessionId!);
  assert.equal(Boolean(sessionsDb.getSessionById(indexed.sessionId!)?.isArchived), true);
  const other = randomUUID();
  const otherItem = { ...item, path: item.path.replace(id, other), data: Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: other, cwd: projectPath } }) + '\n').toString('base64'), mtimeMs: Date.now() };
  await publishIsolationHistorySnapshot(home, otherItem);
  // Exporting another turn still includes the old transcript, but must not fabricate its activity.
  assert.equal(await publishIsolationHistorySnapshot(home, { ...item, mtimeMs: Date.now() }), false);
  await sessionSynchronizerService.synchronizeProviderFile('codex', path.join(home, otherItem.path));
  await sessionSynchronizerService.synchronizeProviderFile('codex', path.join(home, item.path));
  assert.equal(Boolean(sessionsDb.getSessionById(indexed.sessionId!)?.isArchived), true);
  assert.ok(sessionsDb.getArchivedSessions().some((session) => session.session_id === indexed.sessionId));
  assert.ok(!sessionsDb.getSessionsByProjectPath(projectPath).some((session) => session.session_id === indexed.sessionId));
});

test('snapshot publication rejects traversal and invalid timestamps before writing', async () => {
  for (const item of [
    { path: '../auth.json', data: '', mtimeMs: 1 },
    { path: 'sessions/x.jsonl', data: '', mtimeMs: NaN },
    { path: 'auth.json', data: '', mtimeMs: 1 },
  ]) await assert.rejects(publishIsolationHistorySnapshot(path.join(root, 'invalid'), item), /Invalid isolated/);
});


test('history export remains usable when unrelated files total more than 128 MiB', async () => {
  const home = path.join(root, 'large-project');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  for (const name of ['old-a.jsonl', 'old-b.jsonl']) {
    const file = await fs.open(path.join(home, 'sessions', name), 'w');
    await file.truncate(70 * 1024 * 1024);
    await file.close();
  }
  await fs.writeFile(path.join(home, 'sessions/current.jsonl'), '{"type":"session_meta"}\n');
  await fs.symlink('/etc/passwd', path.join(home, 'sessions/unsafe.jsonl'));
  const env = { ...process.env, CODEX_HOME: home };
  const entries = parseIsolationHistoryManifest(JSON.parse(execFileSync(process.execPath, ['-e', isolationHistoryManifestScript()], { env, encoding: 'utf8' })));
  assert.ok(entries.reduce((sum, entry) => sum + entry.size, 0) > 128 * 1024 * 1024);
  assert.equal(entries.length, 3);
  const snapshot = JSON.parse(execFileSync(process.execPath, ['-e', isolationHistoryFileScript(), 'sessions/current.jsonl'], { env, encoding: 'utf8' }));
  assert.equal(Buffer.from(snapshot.data, 'base64').toString(), '{"type":"session_meta"}\n');
  assert.throws(() => execFileSync(process.execPath, ['-e', isolationHistoryFileScript(), 'sessions/unsafe.jsonl'], { env, stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, ['-e', isolationHistoryFileScript(), '../auth.json'], { env, stdio: 'pipe' }));
  const oversized = await fs.open(path.join(home, 'sessions/oversized.jsonl'), 'w');
  await oversized.truncate(129 * 1024 * 1024); await oversized.close();
  assert.throws(() => execFileSync(process.execPath, ['-e', isolationHistoryFileScript(), 'sessions/oversized.jsonl'], { env, stdio: 'pipe' }));
  // Oversize protection applies to that file, not to another valid thread.
  assert.doesNotThrow(() => JSON.parse(execFileSync(process.execPath, ['-e', isolationHistoryFileScript(), 'sessions/current.jsonl'], { env, encoding: 'utf8' })));
});

test('history manifest rejects unsafe paths and invalid sizes', () => {
  for (const entry of [
    { path: '../auth.json', size: 1, mtimeMs: 1 },
    { path: 'sessions/x.jsonl', size: -1, mtimeMs: 1 },
    { path: 'sessions/x.jsonl', size: 1, mtimeMs: NaN },
  ]) assert.throws(() => parseIsolationHistoryManifest([entry]), /Invalid isolated/);
});


test('publishing a missing snapshot indexes the existing app session instead of duplicating it', async () => {
  const workspace = path.join(root, 'recovery-workspace'); await fs.mkdir(workspace);
  const project = projectsDb.createProjectPath(workspace, 'Recovery', undefined, true).project;
  assert.ok(project);
  const appId = randomUUID(), providerId = randomUUID();
  sessionsDb.createSession(appId, 'codex', workspace, 'Recovered app session');
  sessionsDb.assignProviderSessionId(appId, providerId);
  assert.equal(sessionsDb.getSessionById(appId)?.jsonl_path, null);
  const home = path.join(process.env.CLOUDCLI_ISOLATION_STATE_DIR!, project.project_id, 'codex');
  const relative = `sessions/2026/11/05/rollout-2026-11-05T00-00-00-${providerId}.jsonl`;
  await publishIsolationHistorySnapshot(home, { path: relative, data: Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: providerId, cwd: workspace } }) + '\n').toString('base64'), mtimeMs: Date.now() });
  const result = await sessionSynchronizerService.synchronizeProviderFile('codex', path.join(home, relative));
  assert.equal(result.sessionId, appId);
  assert.equal(sessionsDb.getSessionById(appId)?.jsonl_path, path.join(home, relative));
  assert.equal(sessionsDb.getSessionById(providerId), null);
});
