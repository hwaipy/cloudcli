import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderAvailableModelsService } from '@/modules/providers/services/provider-available-models.service.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const status = (installed: boolean, authenticated: boolean): ProviderAuthStatus => ({ installed, provider: 'claude', installedVersion: null, authenticated, email: null, method: null });

test('new conversations never receive models for a missing or unauthenticated backend CLI', async () => {
  for (const state of [status(false, false), status(true, false)]) {
    const service = createProviderAvailableModelsService({ getAuthStatus: async () => state, getModels: async () => { assert.fail('unavailable provider must not produce a catalog'); } });
    assert.deepEqual(await service.getAvailableModels('claude'), { OPTIONS: [], DEFAULT: '' });
  }
});

test('available models come from this backend catalog, including its explicit custom models', async () => {
  const catalog = { OPTIONS: [{ value: 'backend-custom', label: 'Backend model' }], DEFAULT: 'backend-custom' };
  const service = createProviderAvailableModelsService({ getAuthStatus: async () => status(true, true), getModels: async (provider) => { assert.equal(provider,'claude'); return catalog; } });
  assert.equal(await service.getAvailableModels('claude'), catalog);
});

test('a failed auth probe fails closed instead of serving another host or static fallback models', async () => {
  const service = createProviderAvailableModelsService({ getAuthStatus: async () => { throw Error('host offline'); } });
  await assert.rejects(service.getAvailableModels('codex'), /host offline/);
});
