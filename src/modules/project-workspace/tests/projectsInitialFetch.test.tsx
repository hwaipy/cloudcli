import assert from 'node:assert/strict';

import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the sidebar's loading screen appearing twice per refresh.
 *
 * The mount effect used to depend only on `fetchProjects`, so StrictMode's
 * double-invoked effects issued two `/api/projects` requests. Each one makes the
 * server re-scan every provider transcript and re-broadcast `loading_progress`
 * from zero, so the sidebar replayed its whole progress bar a second time.
 */

const projectsResponse = vi.fn();
const hubBackendsResponse = vi.fn();
const projectsByBackendResponse = vi.fn();
const projectSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: (backendId?: string, options?: RequestInit) => backendId ? projectsByBackendResponse(backendId, options) : projectsResponse(),
    hub: { backends: (options?: RequestInit) => hubBackendsResponse(options) },
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: (...args: unknown[]) => projectSessionsResponse(...args),
  },
}));

const buildProject = (): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
});

type ServerEventListener = (event: { kind: string }) => void;

const listeners = new Set<ServerEventListener>();

const renderProjectsState = async (wrapper?: (props: { children: ReactNode }) => ReactNode) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(
    () =>
      useProjectsState({
        sessionId: undefined,
        navigate: vi.fn(),
        subscribe: (listener: ServerEventListener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        isMobile: false,
        isSessionProcessing: () => false,
      }),
    wrapper ? { wrapper } : undefined,
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  hubBackendsResponse.mockReset();
  projectsByBackendResponse.mockReset();
  projectSessionsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject()],
  });
  listeners.clear();
  delete (window as Window & { __CLOUDCLI_BACKEND_ID__?: string }).__CLOUDCLI_BACKEND_ID__;
});

afterEach(() => {
  vi.resetModules();
});

test('the mount fetch runs once even when StrictMode remounts the tree', async () => {
  const { result } = await renderProjectsState(({ children }) => (
    <StrictMode>{children}</StrictMode>
  ));

  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });

  assert.equal(projectsResponse.mock.calls.length, 1);
  assert.equal(result.current.projects.length, 1);
});

test('an explicit refresh still reaches the server after the mount fetch', async () => {
  const { result } = await renderProjectsState(({ children }) => (
    <StrictMode>{children}</StrictMode>
  ));

  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });

  await result.current.refreshProjectsSilently();

  assert.equal(projectsResponse.mock.calls.length, 2);
});

test('aggregates projects from every Hub server and tags their project and session ownership', async () => {
  (window as Window & { __CLOUDCLI_BACKEND_ID__?: string }).__CLOUDCLI_BACKEND_ID__ = 'office';
  hubBackendsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ backends: [{ id: 'office', name: 'OfficeMac' }, { id: 'lab', name: 'Lab', color: '#8b5cf6' }] }),
  });
  projectsByBackendResponse.mockImplementation(async (backendId: string) => ({
    ok: true,
    json: async () => [{
      ...buildProject(),
      projectId: `project-${backendId}`,
      sessions: [{ id: `session-${backendId}`, summary: 'Session' }],
    }],
  }));

  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));

  assert.deepEqual(result.current.projects.map((project) => project.projectId), ['project-office', 'project-lab']);
  assert.equal(result.current.projects[1].__hubBackendId, 'lab');
  assert.equal(result.current.projects[1].__hubBackendName, 'Lab');
  assert.equal(result.current.projects[1].__hubBackendColor, '#8b5cf6');
  assert.equal(result.current.projects[1].sessions?.[0].__hubBackendId, 'lab');
  assert.deepEqual(projectsByBackendResponse.mock.calls.map(([backendId]) => backendId), ['office', 'lab']);

  // Offline servers retain their projects and still receive edited display metadata.
  hubBackendsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ backends: [
      { id: 'office', name: 'OfficeMac' },
      { id: 'lab', name: 'New Lab', color: '#10b981' },
    ] }),
  });
  projectsByBackendResponse.mockImplementation(async (backendId: string) => ({
    ok: backendId !== 'lab', status: 503,
    json: async () => [{ ...buildProject(), projectId: `project-${backendId}`, sessions: [{ id: `session-${backendId}`, summary: 'Session' }] }],
  }));
  await act(async () => { await result.current.refreshProjectsSilently(); });
  assert.equal(result.current.projects.length, 2);
  const offlineProject = result.current.projects.find((project) => project.projectId === 'project-lab');
  assert.equal(offlineProject?.__hubBackendName, 'New Lab · 离线');
  assert.equal(offlineProject?.__hubBackendColor, '#10b981');

  const { readDraftText, writeDraftText } = await import('@/shared/chatDrafts');
  const originalProjects = result.current.projects;
  writeDraftText('project:project-lab', 'previous new conversation');
  writeDraftText('session-office', 'keep existing session draft');
  await act(async () => result.current.handleNewSession(originalProjects[1]));
  assert.equal(result.current.selectedProject?.projectId, 'project-lab');
  assert.equal(Boolean(result.current.selectedSession), false);
  assert.equal(result.current.projects, originalProjects);
  assert.equal(result.current.newSessionTrigger, 1);
  assert.equal(readDraftText('project:project-lab'), '');
  assert.equal(readDraftText('session-office'), 'keep existing session draft');
  writeDraftText('project:project-lab', 'another draft');
  await act(async () => result.current.handleNewSession(originalProjects[1]));
  assert.equal(result.current.newSessionTrigger, 2);
  assert.equal(readDraftText('project:project-lab'), '');
  assert.equal(localStorage.getItem('cloudcli-hub-new-session-project'), null);
  await act(async () => result.current.handleSessionSelect(originalProjects[0].sessions![0]));
  assert.equal(result.current.selectedProject?.projectId, 'project-office');
  assert.equal(result.current.selectedSession?.id, 'session-office');
  assert.equal(result.current.projects, originalProjects);

});

test('background project refresh waits ten seconds, stays quiet and never overlaps a slow scan', async () => {
  vi.useFakeTimers();
  const view = await renderProjectsState();
  try {
    await act(async () => {});
    assert.equal(projectsResponse.mock.calls.length, 1);
    let finish!: (response: { ok: boolean; json: () => Promise<Project[]> }) => void;
    projectsResponse.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    assert.equal(projectsResponse.mock.calls.length, 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    assert.equal(projectsResponse.mock.calls.length, 2);
    assert.equal(view.result.current.isLoadingProjects, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    assert.equal(projectsResponse.mock.calls.length, 2);
    const updated = { ...buildProject(), displayName: 'Updated in background' };
    await act(async () => { finish({ ok: true, json: async () => [updated] }); });
    assert.equal(view.result.current.projects[0].displayName, updated.displayName);
    assert.equal(view.result.current.isLoadingProjects, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.equal(projectsResponse.mock.calls.length, 3);
    view.unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    assert.equal(projectsResponse.mock.calls.length, 3);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('background project refresh skips hidden tabs and an unfinished initial load', async () => {
  vi.useFakeTimers();
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  let finish!: (response: { ok: boolean; json: () => Promise<Project[]> }) => void;
  projectsResponse.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = await renderProjectsState();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.equal(projectsResponse.mock.calls.length, 1);
    await act(async () => { finish({ ok: true, json: async () => [buildProject()] }); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.equal(projectsResponse.mock.calls.length, 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.equal(projectsResponse.mock.calls.length, 2);
  } finally {
    view.unmount(); vi.useRealTimers();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});


test('returning to the window refreshes sessions immediately and coalesces resume events', async () => {
  const view = await renderProjectsState();
  await waitFor(() => assert.equal(view.result.current.isLoadingProjects, false));
  let finish!: (response: { ok: boolean; json: () => Promise<Project[]> }) => void;
  projectsResponse.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  assert.equal(projectsResponse.mock.calls.length, 2);
  const refreshed = { ...buildProject(), sessions: [{ id: 'external-session', summary: 'Created elsewhere' }] };
  await act(async () => { finish({ ok: true, json: async () => [refreshed] }); });
  assert.equal(view.result.current.projects[0].sessions?.[0].id, 'external-session');
  view.unmount();
  window.dispatchEvent(new Event('focus'));
  assert.equal(projectsResponse.mock.calls.length, 2);
});

test('a stalled backend times out without permanently blocking automatic refresh', async () => {
  vi.useFakeTimers();
  (window as Window & { __CLOUDCLI_BACKEND_ID__?: string }).__CLOUDCLI_BACKEND_ID__ = 'office';
  hubBackendsResponse.mockResolvedValue({ ok: true, json: async () => ({ backends: [
    { id: 'office', name: 'Mac' }, { id: 'lab', name: 'Lab' },
  ] }) });
  // A controllable timeout avoids depending on Node native AbortSignal timers.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Timed out')), ms);
    return controller.signal;
  });
  projectsByBackendResponse.mockImplementation(async (id: string, options?: RequestInit) => {
    if (id === 'lab') return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
    return { ok: true, json: async () => [{ ...buildProject(), sessions: [{ id: 'new-session', summary: 'New' }] }] };
  });
  const view = await renderProjectsState();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    assert.equal(view.result.current.isLoadingProjects, false);
    assert.equal(view.result.current.projects[0].sessions?.[0].id, 'new-session');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.equal(projectsByBackendResponse.mock.calls.length, 4);
  } finally {
    view.unmount(); vi.restoreAllMocks(); vi.useRealTimers();
  }
});


test('automatic refresh removes a session archived on another device instead of merging it back', async () => {
  vi.useFakeTimers();
  projectsResponse.mockResolvedValueOnce({ ok: true, json: async () => [{ ...buildProject(),
    sessions: [{ id: 'archived-elsewhere', summary: 'Gone' }, { id: 'remaining', summary: 'Keep' }],
    sessionMeta: { hasMore: false, total: 2 },
  }] });
  const view = await renderProjectsState();
  try {
    await act(async () => {});
    projectsResponse.mockResolvedValue({ ok: true, json: async () => [{ ...buildProject(),
      sessions: [{ id: 'remaining', summary: 'Keep' }], sessionMeta: { hasMore: false, total: 1 },
    }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.deepEqual(view.result.current.projects[0].sessions?.map((session) => session.id), ['remaining']);
    assert.equal(view.result.current.projects[0].sessionMeta?.total, 1);
    projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    assert.deepEqual(view.result.current.projects[0].sessions, []);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('refresh revalidates expanded pages and keeps Hub ownership without restoring stale rows', async () => {
  (window as Window & { __CLOUDCLI_BACKEND_ID__?: string }).__CLOUDCLI_BACKEND_ID__ = 'office';
  hubBackendsResponse.mockResolvedValue({ ok: true, json: async () => ({ backends: [{ id: 'office', name: 'Mac' }] }) });
  const session = (id: string) => ({ id, summary: id });
  projectsByBackendResponse.mockResolvedValueOnce({ ok: true, json: async () => [{ ...buildProject(),
    sessions: ['a', 'b', 'c', 'archived'].map(session), sessionMeta: { hasMore: false, total: 4 },
  }] });
  const view = await renderProjectsState();
  try {
    await waitFor(() => assert.equal(view.result.current.isLoadingProjects, false));
    projectsByBackendResponse.mockResolvedValue({ ok: true, json: async () => [{ ...buildProject(),
      sessions: ['a', 'b'].map(session), sessionMeta: { hasMore: true, total: 3 },
    }] });
    projectSessionsResponse.mockResolvedValue({ ok: true, json: async () => ({
      sessions: [session('c')], sessionMeta: { hasMore: false, total: 3 },
    }) });
    await act(async () => { await view.result.current.refreshProjectsSilently(); });
    assert.deepEqual(view.result.current.projects[0].sessions?.map((row) => row.id), ['a', 'b', 'c']);
    assert.equal(view.result.current.projects[0].sessionMeta?.total, 3);
    assert.equal(view.result.current.projects[0].sessions?.[2].__hubBackendId, 'office');
    assert.equal(projectSessionsResponse.mock.calls[0][2].hubBackendId, 'office');
    assert.equal(projectSessionsResponse.mock.calls[0][1].offset, 2);
  } finally { view.unmount(); }
});
