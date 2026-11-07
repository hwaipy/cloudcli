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

vi.mock('@/shared/api', () => ({
  api: {
    projects: (backendId?: string) => backendId ? projectsByBackendResponse(backendId) : projectsResponse(),
    hub: { backends: () => hubBackendsResponse() },
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
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
    json: async () => [{ ...buildProject(), projectId: `project-${backendId}` }],
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
