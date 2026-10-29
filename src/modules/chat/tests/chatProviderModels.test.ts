import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: vi.fn(() => okJson({ success: true, data: null })),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      setSessionPermissionMode: vi.fn(() => okJson({ success: true, data: null })),
      sessionPermissionMode: vi.fn(() => okJson({ success: true, data: null })),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

test('an open session takes its permission from the server across browser-local defaults', async () => {
  const serverSelection = (permissionMode: string) => okJson({
    success: true,
    data: { provider: 'codex', sessionId: 'shared-session', model: 'gpt-5.6-sol',
      effort: null, permissionMode, source: 'session' },
  }) as unknown as Promise<Response>;
  let storedMode = 'bypassPermissions';
  vi.mocked(api.providers.sessionPermissionMode).mockImplementation(() => serverSelection(storedMode));
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('permissionMode-shared-session', 'default');
  localStorage.setItem('permissionMode-last-codex', 'acceptEdits');

  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const session = { id: 'shared-session', __provider: 'codex' as const };
  const first = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => assert.equal(first.result.current.permissionMode, 'bypassPermissions'));
  first.unmount();

  // A second browser has no local choice for this session, but reads the same
  // authoritative value rather than inheriting its own provider default.
  localStorage.clear();
  localStorage.setItem('permissionMode-last-codex', 'default');
  const second = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => assert.equal(second.result.current.permissionMode, 'bypassPermissions'));
  storedMode = 'acceptEdits';
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => assert.equal(second.result.current.permissionMode, 'acceptEdits'));
  second.unmount();
});

test('a late permission read cannot undo a mode chosen in the open session', async () => {
  let finishRead!: (response: Response) => void;
  vi.mocked(api.providers.sessionPermissionMode).mockReturnValue(new Promise((resolve) => {
    finishRead = resolve;
  }));
  writeUserPreference('selectedProvider', 'codex');
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { result } = renderHook(() => useChatProviderState({
    selectedSession: { id: 'shared-session', __provider: 'codex' },
    selectedProject: null,
  }));

  act(() => result.current.selectPermissionMode('bypassPermissions'));
  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  await waitFor(() => assert.equal(vi.mocked(api.providers.setSessionPermissionMode).mock.calls.length, 1));

  await act(async () => {
    finishRead(await okJson({ success: true, data: { permissionMode: 'default' } }) as unknown as Response);
  });
  assert.equal(result.current.permissionMode, 'bypassPermissions');
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});
