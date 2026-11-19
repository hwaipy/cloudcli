import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { LLMProvider, Project, ProviderModelsDefinition } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

const models = vi.fn();
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: {
  user: { preferences: () => ok({}), savePreferences: () => ok({}) },
  providers: {
    models: (...args: unknown[]) => models(...args), capabilities: () => ok(null),
    sessionActiveModel: () => ok(null), sessionPermissionMode: () => ok(null),
  },
} }));
const project = (backend: string, strict = false): Project => ({ projectId: backend, path: '/repo', fullPath: '/repo', displayName: backend, isStarred: false, __hubBackendId: backend, strictFileIsolation: strict });
const catalog = (value: string): ProviderModelsDefinition => ({ OPTIONS: [{ value, label: value }], DEFAULT: value });
const empty = { OPTIONS: [], DEFAULT: '' };
afterEach(() => { models.mockReset(); localStorage.clear(); resetUserPreferences(); });

test('new conversation models are scoped to the selected host and strict containers only expose Codex', async () => {
  models.mockImplementation((provider: LLMProvider, backend: string, availableOnly: boolean) => {
    assert.equal(availableOnly, true);
    return ok({ models: backend === 'mac' && provider === 'claude' ? catalog('sonnet') : provider === 'codex' ? catalog(`${backend}-codex`) : empty });
  });
  const view = renderHook(({ selectedProject }) => useChatProviderState({ selectedProject, selectedSession: null }), { initialProps: { selectedProject: project('mac') } });
  await waitFor(() => assert.equal(view.result.current.providerModelsLoading, false));
  assert.equal(view.result.current.providerModelCatalog.claude?.OPTIONS[0].value, 'sonnet');
  view.rerender({ selectedProject: project('ubuntu', true) });
  assert.equal(view.result.current.providerModelCatalog.claude, undefined);
  await waitFor(() => assert.equal(view.result.current.providerModelsLoading, false));
  assert.equal(view.result.current.providerModelCatalog.codex?.OPTIONS[0].value, 'ubuntu-codex');
  assert.equal(view.result.current.provider, 'codex');
  assert.equal(view.result.current.currentProviderModelOptions.some(row => row.value === 'sonnet'), false);
});

test('a late response from the previous backend cannot reintroduce its models', async () => {
  let finish!: (value: unknown) => void;
  models.mockImplementation((provider: LLMProvider, backend: string) => backend === 'old' && provider === 'claude'
    ? new Promise(resolve => { finish = resolve; })
    : ok({ models: backend === 'new' && provider === 'codex' ? catalog('new-codex') : empty }));
  const view = renderHook(({ selectedProject }) => useChatProviderState({ selectedProject, selectedSession: null }), { initialProps: { selectedProject: project('old') } });
  await act(async () => {});
  view.rerender({ selectedProject: project('new') });
  await waitFor(() => assert.equal(view.result.current.providerModelsLoading, false));
  await act(async () => { finish({ ok: true, json: async () => ({ success: true, data: { models: catalog('old-claude') } }) }); });
  assert.equal(view.result.current.providerModelCatalog.claude?.OPTIONS.length, 0);
  assert.equal(view.result.current.providerModelCatalog.codex?.OPTIONS[0].value, 'new-codex');
});
