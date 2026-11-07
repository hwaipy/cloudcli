import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { api } from '@/shared/api';
import { getHubRequestBackend, registerHubResourceBackend } from '@/shared/utils';
import { openConversationSearch } from '@/shared/hubSearch';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const listing = { defaultBackendId: 'office', backends: [{ id: 'office', name: 'OfficeMac' }, { id: 'lab', name: 'Lab' }] };
let token: string;
beforeEach(() => {
  window.history.replaceState({}, '', '/cloudcli/?hub_backend=lab');
  const now = Math.floor(Date.now() / 1000);
  token = 'header.' + btoa(JSON.stringify({ hubUserId: 'owner', iat: now, exp: now + 600 })) + '.signature';
  localStorage.setItem('auth-token:hub', token);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

test('account preferences ignore page backend and a backend 401 cannot remove Hub login', async () => {
  const request = vi.fn().mockResolvedValue(json({ preferences: { projectSortOrder: 'date' } }));
  vi.stubGlobal('fetch', request);
  await api.user.preferences();
  expect(request.mock.calls[0][0]).toBe('/hub/auth/preferences');
  registerHubResourceBackend('project', 'isolation-lab', 'lab');
  request.mockResolvedValue(new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'invalid-token' } }));
  await api.projectSessions('isolation-lab');
  expect(localStorage.getItem('auth-token:hub')).toBe(token);
});

test('drafts hydrate every owner and subsequent writes follow the draft scope', async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/hub/backends') return json(listing);
    if (init?.method === 'PUT') return json({ success: true });
    const backend = new URL(url, 'http://local').searchParams.get('hub_backend');
    return json({ drafts: [{ scope: 'project:draft-' + backend, text: backend, queuedMessage: null }] });
  });
  vi.stubGlobal('fetch', request);
  const result = await (await api.user.drafts()).json();
  expect(result.drafts).toHaveLength(2);
  expect(getHubRequestBackend('/api/user/drafts', JSON.stringify({ scope: 'project:draft-lab' }))).toBe('lab');
  await api.user.saveDraft('project:draft-lab', { text: 'preserved text' });
  expect(request.mock.calls.at(-1)![0]).toBe('/api/user/drafts?hub_backend=lab');
  expect(api.uploadFilesUrl('draft-lab')).toContain('hub_backend=lab');
});

test('an offline draft backend returns failure instead of an empty authoritative snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/hub/backends'
    ? json({ backends: [{ id: 'lab', online: false }] }) : json({ drafts: [] })));
  expect((await api.user.drafts()).status).toBe(503);
});

test('running and archived lists aggregate backend resources', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/hub/backends') return json(listing);
    const backend = new URL(url, 'http://local').searchParams.get('hub_backend');
    return json({ data: { sessions: [{ sessionId: 'running-' + backend }], projects: [{ projectId: 'archived-' + backend }] } });
  }));
  expect((await (await api.runningSessions()).json()).data.sessions).toHaveLength(2);
  expect((await (await api.archivedProjects()).json()).data.projects).toHaveLength(2);
});

test('conversation search keeps both sources and waits for both to finish', async () => {
  class Source {
    static all: Source[] = [];
    handlers = new Map<string, Array<(event: MessageEvent) => void>>();
    close = vi.fn();
    constructor(readonly url: string) { Source.all.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
    }
    emit(type: string, value: unknown = {}) {
      for (const listener of this.handlers.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(value) }));
    }
  }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(listing)));
  vi.stubGlobal('EventSource', Source);
  const search = openConversationSearch('something');
  const done = vi.fn();
  const titles: unknown[] = [];
  search.addEventListener('done', done);
  search.addEventListener('title-results', (event) => titles.push(JSON.parse(event.data).titleResults));
  await waitFor(() => expect(Source.all).toHaveLength(2));
  expect(Source.all[0].url).toContain('hub_backend=office');
  expect(Source.all[1].url).toContain('hub_backend=lab');
  Source.all[0].emit('title-results', { titleResults: [{ sessionId: 'search-office' }] });
  Source.all[1].emit('title-results', { titleResults: [{ sessionId: 'search-lab' }] });
  expect(titles.at(-1)).toHaveLength(2);
  Source.all[0].emit('done');
  expect(done).not.toHaveBeenCalled();
  Source.all[1].emit('done');
  expect(done).toHaveBeenCalledOnce();
  expect(getHubRequestBackend('/ws', JSON.stringify({ sessionId: 'search-lab' }))).toBe('lab');
  search.close();
});

test('a session deep link discovers its owner instead of using a default backend', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/hub/backends') return json(listing);
    return url.includes('hub_backend=lab')
      ? json({ data: { sessionId: 'deep-link-lab', project: { projectId: 'deep-link-project' } } })
      : json({ error: 'not found' }, 404);
  }));
  expect((await api.sessionDetails('deep-link-lab')).status).toBe(200);
  expect(getHubRequestBackend('/api/providers/sessions/deep-link-lab')).toBe('lab');
  expect(getHubRequestBackend('/api/projects/deep-link-project/sessions')).toBe('lab');
});

test('recent conversations use one global time order and page across all backends', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/hub/backends') return json(listing);
    const backend = new URL(url, 'http://local').searchParams.get('hub_backend');
    const conversations = backend === 'office'
      ? [{ sessionId: 'recent-office', lastActivity: '2026-11-01T10:00:00Z' }]
      : [{ sessionId: 'recent-lab', lastActivity: '2026-11-01T11:00:00Z' }];
    return json({ data: { conversations, total: 1, hasMore: false } });
  }));
  const first = await (await api.recentConversations({ limit: 1, offset: 0 })).json();
  expect(first.data.conversations[0].sessionId).toBe('recent-lab');
  expect(first.data.total).toBe(2);
  expect(first.data.hasMore).toBe(true);
  const second = await (await api.recentConversations({ limit: 1, offset: 1 })).json();
  expect(second.data.conversations[0].sessionId).toBe('recent-office');
});
