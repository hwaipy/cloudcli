import assert from 'node:assert/strict';
import test from 'node:test';

import { createHubIdentityAssertion, verifyHubIdentityAssertion } from '@/shared/index.js';

test('Hub identity assertions are short-lived and bound to one backend key', () => {
  const identity = { hubUserId: 'user-123', username: 'alice', isAdmin: true };
  const assertion = createHubIdentityAssertion(identity, 'ubuntu-vm', 'backend-private-key', 1_000);
  assert.deepEqual(verifyHubIdentityAssertion(assertion, 'ubuntu-vm', 'backend-private-key', 2_000), {
    ...identity,
    backendId: 'ubuntu-vm',
    expiresAt: 61_000,
  });
  assert.equal(verifyHubIdentityAssertion(assertion, 'office', 'backend-private-key', 2_000), null);
  assert.equal(verifyHubIdentityAssertion(assertion, 'ubuntu-vm', 'wrong-key', 2_000), null);
  assert.equal(verifyHubIdentityAssertion(assertion, 'ubuntu-vm', 'backend-private-key', 61_000), null);
});
