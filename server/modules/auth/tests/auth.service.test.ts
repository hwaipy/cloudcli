import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      listUsers: () => [{ id: 1, username: 'alice' }],
      getUserByUsername: () => undefined,
      getCredentialsById: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateAccount: () => undefined,
      updateAvatar: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      listUsers: () => [{ id: 1, username: 'alice' }],
      getUserByUsername: () => undefined,
      getCredentialsById: () => undefined,
      updateAccount: () => undefined,
      updateAvatar: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      listUsers: () => [{ id: 1, username: 'alice' }],
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      getCredentialsById: () => undefined,
      updateAccount: () => undefined,
      updateAvatar: () => undefined,
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('only the original administrator can add an account', async () => {
  const service = createAuthService(createDependencies());
  await assert.rejects(
    service.createManagedUser({ id: 2 }, 'bob', 'secret12'),
    (error: unknown) => error instanceof AppError && error.code === 'ADMIN_REQUIRED',
  );
  const created = await service.createManagedUser({ id: 1 }, 'bob', 'secret12');
  assert.equal(created.user.username, 'bob');
});

test('platform authentication cannot add accounts it cannot distinguish', async () => {
  const service = createAuthService(createDependencies({ platformMode: true }));
  await assert.rejects(
    service.createManagedUser({ id: 1 }, 'bob', 'secret12'),
    (error: unknown) => error instanceof AppError && error.code === 'MULTI_USER_UNAVAILABLE',
  );
});

test('an account can update only itself after verifying its current password', async () => {
  const changes: unknown[][] = [];
  const service = createAuthService(createDependencies({
    comparePassword: async (password) => password === 'current-secret',
    users: {
      ...createDependencies().users,
      getCredentialsById: (id) => id === 1 ? { id, username: 'alice', password_hash: 'hash' } : undefined,
      updateAccount: (...args) => { changes.push(args); },
    },
  }));
  await assert.rejects(service.updateOwnAccount({ id: 1 }, 'new-alice', 'wrong', undefined));
  assert.deepEqual(changes, []);
  assert.deepEqual(await service.updateOwnAccount({ id: 1 }, 'new-alice', 'current-secret', 'new-secret'), {
    user: { id: 1, username: 'new-alice' },
  });
  assert.deepEqual(changes, [[1, 'new-alice', 'hashed-password']]);
});

test('administrator may edit another account but cannot bypass self verification', async () => {
  const changes: unknown[][] = [];
  const service = createAuthService(createDependencies({
    users: {
      ...createDependencies().users,
      getCredentialsById: (id) => ({ id, username: id === 1 ? 'alice' : 'bob', password_hash: 'hash' }),
      updateAccount: (...args) => { changes.push(args); },
    },
  }));
  await assert.rejects(service.updateManagedUser({ id: 2 }, 3, 'charlie', undefined));
  await assert.rejects(service.updateManagedUser({ id: 1 }, 1, 'alice-new', undefined));
  await service.updateManagedUser({ id: 1 }, 2, 'bob-new', undefined);
  assert.deepEqual(changes, [[2, 'bob-new', undefined]]);
});

test('avatar updates belong to the authenticated account and reject unsafe image data', () => {
  const updates: Array<[number, string | null]> = [];
  const service = createAuthService(createDependencies({
    users: {
      ...createDependencies().users,
      getCredentialsById: (id) => id === 2 ? { id, username: 'bob', password_hash: 'hash' } : undefined,
      updateAvatar: (id, avatar) => { updates.push([id, avatar]); },
    },
  }));
  assert.throws(() => service.updateOwnAvatar({ id: 1 }, 'preset:fox'));
  assert.throws(() => service.updateOwnAvatar({ id: 2 }, 'preset:unknown'));
  assert.throws(() => service.updateOwnAvatar({ id: 2 }, 'data:image/svg+xml;base64,PHN2Zz4='));
  assert.throws(() => service.updateOwnAvatar({ id: 2 }, 'data:image/png;base64,PHNjcmlwdD4='));
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  assert.deepEqual(service.updateOwnAvatar({ id: 2 }, 'preset:fox'), { avatar: 'preset:fox' });
  assert.deepEqual(service.updateOwnAvatar({ id: 2 }, photo), { avatar: photo });
  assert.deepEqual(service.updateOwnAvatar({ id: 2 }, null), { avatar: null });
  assert.deepEqual(updates, [[2, 'preset:fox'], [2, photo], [2, null]]);
});
