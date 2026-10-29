import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: async () => ({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

vi.mock('@/modules/sidebar/utils/sidebarStoredPreferences', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  readProjectSortOrder: () => 'date',
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const project = (projectId: string, lastActivity: string): Project => ({
  projectId,
  displayName: projectId,
  sessions: [{ id: `${projectId}-session`, lastActivity }],
} as Project);

const t = ((key: string) => key) as TFunction;
const ids = (projects: Project[]) => projects.map((item) => item.projectId);

test('the sidebar stabilizes live order and resets to exact time order on reload', async () => {
  const onRefresh = vi.fn(async () => {});
  const useControllerWithProjects = ({ projects, isLoading }: { projects: Project[]; isLoading: boolean }) => useSidebarController({
    projects,
    isLoading,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isMobile: false,
    t,
    onRefresh,
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  });
  const initial = [
    project('a', '2026-10-29T10:00:00.000Z'),
    project('b', '2026-10-29T09:59:00.000Z'),
  ];
  const view = renderHook(useControllerWithProjects, { initialProps: { projects: initial, isLoading: true } });
  view.rerender({ projects: initial, isLoading: false });
  await waitFor(() => assert.deepEqual(ids(view.result.current.filteredProjects), ['a', 'b']));

  view.rerender({ projects: [initial[0], project('b', '2026-10-29T10:09:00.000Z')], isLoading: false });
  assert.deepEqual(ids(view.result.current.filteredProjects), ['a', 'b']);

  view.rerender({ projects: [initial[0], project('b', '2026-10-29T10:11:00.000Z')], isLoading: false });
  assert.deepEqual(ids(view.result.current.filteredProjects), ['b', 'a']);

  const refreshed = [project('a', '2026-10-29T10:12:00.000Z'), project('b', '2026-10-29T10:11:00.000Z')];
  view.rerender({ projects: refreshed, isLoading: false });
  assert.deepEqual(ids(view.result.current.filteredProjects), ['b', 'a']);

  await act(async () => { await view.result.current.refreshProjects(); });
  view.rerender({ projects: [...refreshed], isLoading: false });
  assert.equal(onRefresh.mock.calls.length, 1);
  assert.deepEqual(ids(view.result.current.filteredProjects), ['a', 'b']);
});
