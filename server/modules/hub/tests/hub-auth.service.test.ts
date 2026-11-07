import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHubAuthService, HubAuthError } from '@/modules/hub/index.js';

test('Hub setup creates the first administrator and persists only a password hash', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-auth-'));
  const authFile = path.join(directory, 'auth.json');
  try {
    const auth = createHubAuthService(authFile);
    assert.deepEqual(auth.getStatus(), { needsSetup: true, isAuthenticated: false });
    const created = auth.register('owner', 'a long and private password') as {
      user: { id: string; username: string; isAdmin: boolean };
      token: string;
    };
    assert.equal(created.user.username, 'owner');
    assert.equal(created.user.isAdmin, true);
    assert.ok(auth.authenticate(created.token)?.isAdmin);
    assert.equal(auth.getStatus().needsSetup, false);

    const saved = await fs.readFile(authFile, 'utf8');
    assert.equal(saved.includes('a long and private password'), false);
    assert.equal(saved.includes('passwordHash'), true);
    assert.throws(() => auth.register('another', 'a different password'), HubAuthError);

    const restarted = createHubAuthService(authFile);
    const login = restarted.login('owner', 'a long and private password') as { token: string };
    assert.equal(restarted.authenticate(login.token)?.username, 'owner');
    assert.equal(restarted.authenticate('not-a-token'), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Hub users preserve administrator-only user management', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-users-'));
  const authFile = path.join(directory, 'auth.json');
  try {
    const auth = createHubAuthService(authFile);
    const admin = auth.register('owner', 'a long and private password') as { token: string };
    const adminIdentity = auth.authenticate(admin.token)!;
    const regular = auth.createUser(adminIdentity, 'member', 'another long password') as {
      user: { id: string; isAdmin: boolean };
    };
    assert.equal(regular.user.isAdmin, false);
    assert.equal(auth.listUsers(adminIdentity).users.length, 2);
    assert.throws(() => auth.listUsers({ id: regular.user.id, username: 'member', isAdmin: false }), HubAuthError);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('account preferences persist, merge, and remain isolated between Hub users', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-preferences-'));
  const file = path.join(directory, 'auth.json');
  try {
    const auth = createHubAuthService(file);
    const session = auth.register('owner', 'a long and private password') as { token: string };
    const owner = auth.authenticate(session.token)!;
    const member = auth.createUser(owner, 'member', 'another long password').user;
    auth.savePreferences(owner, { projectSortOrder: 'date', theme: 'dark' });
    auth.savePreferences(owner, { userLanguage: 'zh-CN' });
    const restarted = createHubAuthService(file);
    assert.deepEqual(restarted.getPreferences(owner).preferences, { projectSortOrder: 'date', theme: 'dark', userLanguage: 'zh-CN' });
    assert.deepEqual(restarted.getPreferences({ id: member.id, username: 'member', isAdmin: false }).preferences, {});
    assert.throws(() => auth.savePreferences(owner, JSON.parse('{"__proto__":{"polluted":true}}')), HubAuthError);
    assert.equal(restarted.login('owner', 'a long and private password').success, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
