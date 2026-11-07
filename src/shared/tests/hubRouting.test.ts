import { expect, test, vi } from 'vitest';

import {
  getHubRequestBackend,
  getHubStorageKey,
  registerHubResourceBackend,
  withHubBackendUrl,
} from '@/shared/utils';

test('Hub caches belong to one account and page selectors cannot select a workspace backend', () => {
  const hubWindow = window as Window & { __CLOUDCLI_BACKEND_ID__?: string };
  hubWindow.__CLOUDCLI_BACKEND_ID__ = 'office';
  try {
    localStorage.setItem('auth-token:hub', 'x.' + btoa(JSON.stringify({ hubUserId: 'original' })) + '.x');
    const cache = getHubStorageKey('chat-drafts');
    expect(cache).toBe('chat-drafts:hub:original');
    window.history.replaceState({}, '', '/cloudcli/?hub_backend=lab');
    expect(getHubStorageKey('chat-drafts', 'lab')).toBe(cache);
    expect(withHubBackendUrl('/api/stream?token=abc')).toBe('/api/stream?token=abc');
    expect(withHubBackendUrl('/api/stream?token=abc', 'lab')).toBe('/api/stream?token=abc&hub_backend=lab');
    localStorage.setItem('auth-token:hub', 'x.' + btoa(JSON.stringify({ hubUserId: 'another' })) + '.x');
    expect(getHubStorageKey('chat-drafts')).not.toBe(cache);
  } finally {
    localStorage.removeItem('auth-token:hub');
    delete hubWindow.__CLOUDCLI_BACKEND_ID__;
    window.history.replaceState({}, '', '/');
  }
});

test('Hub project and session requests route to their owning backend', () => {
  const hubWindow = window as Window & { __CLOUDCLI_BACKEND_ID__?: string };
  hubWindow.__CLOUDCLI_BACKEND_ID__ = 'office';
  registerHubResourceBackend('project', 'project-lab-1', 'lab');
  registerHubResourceBackend('session', 'session-lab-1', 'lab');
  try {
    expect(getHubRequestBackend('/api/projects/project-lab-1/rename')).toBe('lab');
    expect(getHubRequestBackend('/api/git/status?project=project-lab-1')).toBe('lab');
    expect(getHubRequestBackend('/api/providers/sessions/session-lab-1/messages')).toBe('lab');
    expect(getHubRequestBackend('/api/tasks/start', JSON.stringify({ project: 'project-lab-1' }))).toBe('lab');
    expect(getHubRequestBackend('/api/user/drafts', JSON.stringify({ scope: 'project:project-lab-1' }))).toBe('lab');
    expect(getHubRequestBackend('/api/user/drafts/queued-message', JSON.stringify({ scope: 'session-lab-1' }))).toBe('lab');
    expect(withHubBackendUrl('/api/projects/project-lab-1', getHubRequestBackend('/api/projects/project-lab-1')!)).toBe('/api/projects/project-lab-1?hub_backend=lab');
    expect(getHubStorageKey('chat-drafts', 'lab')).toContain('chat-drafts:hub:');
  } finally {
    delete hubWindow.__CLOUDCLI_BACKEND_ID__;
  }
});


test('new sessions use the project backend and register it before the first chat frame', async () => {
  const { api } = await import('@/shared/api');
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: { sessionId: 'new-lab-session' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const response = await api.providers.createSession({ provider: 'codex', projectPath: '/same/path' }, 'lab');
    expect(response.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('hub_backend=lab');
    expect(getHubRequestBackend('/ws', JSON.stringify({ sessionId: 'new-lab-session' }))).toBe('lab');
  } finally {
    vi.unstubAllGlobals();
  }
});
