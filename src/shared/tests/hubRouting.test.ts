import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getHubStorageKey, withHubBackendUrl } from '@/shared/utils';

test('Hub URLs retain existing credentials and do not duplicate a backend selector', () => {
  const hubWindow = window as Window & { __CLOUDCLI_BACKEND_ID__?: string };
  try {
    hubWindow.__CLOUDCLI_BACKEND_ID__ = 'office';
    assert.equal(getHubStorageKey('chat-drafts'), 'chat-drafts:office');
    assert.equal(withHubBackendUrl('/api/stream?token=abc'), '/api/stream?token=abc&hub_backend=office');
    assert.equal(withHubBackendUrl('/api/stream?hub_backend=lab'), '/api/stream?hub_backend=office');
    assert.equal(withHubBackendUrl('wss://example.test/ws?token=abc'), 'wss://example.test/ws?token=abc&hub_backend=office');
  } finally {
    delete hubWindow.__CLOUDCLI_BACKEND_ID__;
  }
  assert.equal(withHubBackendUrl('/api/projects'), '/api/projects');
  assert.equal(getHubStorageKey('chat-drafts'), 'chat-drafts');
});
