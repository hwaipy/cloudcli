import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { validateWorkspacePath } from '@/shared/utils.js';

test('an absolute project path outside the home workspace root is allowed', async () => {
  const outsideHome = path.resolve(os.homedir(), '..', `cloudcli-external-${randomUUID()}`);
  const validation = await validateWorkspacePath(outsideHome);
  assert.deepEqual(validation, { valid: true, resolvedPath: outsideHome });
});

test('system directories remain blocked, including through a symlink ancestor', async () => {
  assert.equal((await validateWorkspacePath('/etc')).valid, false);
  assert.equal((await validateWorkspacePath('/etc/cloudcli-project')).valid, false);

  // The system temp directory remains read-only. Use the home directory for
  // the symlink fixture when it is itself a valid workspace location.
  const temporaryRoot = os.homedir();
  if (!(await validateWorkspacePath(temporaryRoot)).valid) return;

  const fixture = await mkdtemp(path.join(temporaryRoot, 'cloudcli-workspace-link-'));
  try {
    await symlink('/etc', path.join(fixture, 'system'));
    assert.equal((await validateWorkspacePath(path.join(fixture, 'system'))).valid, false);
    assert.equal((await validateWorkspacePath(path.join(fixture, 'system', 'new', 'project'))).valid, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
