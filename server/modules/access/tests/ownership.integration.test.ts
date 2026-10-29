import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { requireOwnedProject, requireOwnedProjectPath, requireOwnedSession } from '@/modules/access/index.js';
import { canReadAsset, recordAssetOwners } from '@/modules/assets/index.js';
import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';

test('two accounts see only their own projects and sessions', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-ownership-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const first = Number(userDb.createUser('first', 'hash').id);
    const second = Number(userDb.createUser('second', 'hash').id);
    userDb.updateAvatar(first, 'preset:fox');
    assert.equal(userDb.getUserById(first)?.avatar, 'preset:fox');
    assert.equal(userDb.getUserById(second)?.avatar, null);
    const firstPath = path.join(directory, 'first');
    const secondPath = path.join(directory, 'second');
    const firstProject = projectsDb.createProjectPath(firstPath, null, first).project;
    const secondProject = projectsDb.createProjectPath(secondPath, null, second).project;
    assert.ok(firstProject && secondProject);
    sessionsDb.createAppSession('first-session', 'codex', firstPath);
    sessionsDb.createAppSession('second-session', 'codex', secondPath);

    assert.deepEqual(projectsDb.getProjectPaths(first).map((row) => row.project_id), [firstProject.project_id]);
    assert.deepEqual(projectsDb.getProjectPaths(second).map((row) => row.project_id), [secondProject.project_id]);
    assert.deepEqual(sessionsDb.getAllSessions(first).map((row) => row.session_id), ['first-session']);
    assert.deepEqual(sessionsDb.getAllSessions(second).map((row) => row.session_id), ['second-session']);
    assert.equal(sessionsDb.getSessionById('second-session', first), null);
    assert.throws(() => requireOwnedProject(first, secondProject.project_id));
    assert.throws(() => requireOwnedProjectPath(first, secondPath));
    assert.throws(() => requireOwnedSession(first, 'second-session'));
    assert.equal(projectsDb.createProjectPath(secondPath, null, first).project?.owner_user_id, second);
    recordAssetOwners([{ filename: 'second-upload.png' }], second);
    assert.equal(canReadAsset('second-upload.png', first), false);
    assert.equal(canReadAsset('second-upload.png', second), true);
    assert.equal(canReadAsset('legacy-upload.png', first), true);
    assert.equal(canReadAsset('legacy-upload.png', second), false);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration assigns existing single-account records to the original account', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-ownership-migration-'));
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME,
      is_active BOOLEAN DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash) VALUES (1, 'original', 'hash');
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE);
    INSERT INTO projects (project_id, project_path) VALUES ('old-project', '/tmp/old-project');
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_path TEXT,
      custom_name TEXT
    );
    INSERT INTO sessions (session_id, provider, project_path) VALUES ('old-session', 'codex', '/tmp/old-project');
  `);
  legacy.close();
  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    assert.equal(projectsDb.getProjectById('old-project')?.owner_user_id, 1);
    assert.equal(sessionsDb.getSessionById('old-session')?.owner_user_id, 1);
    assert.equal(userDb.getUserById(1)?.avatar, null);
    userDb.updateAvatar(1, 'preset:owl');
    assert.equal(userDb.getUserById(1)?.avatar, 'preset:owl');
    const second = Number(userDb.createUser('second', 'hash').id);
    assert.equal(projectsDb.getProjectPaths(second).length, 0);
    assert.equal(sessionsDb.getAllSessions(second).length, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
