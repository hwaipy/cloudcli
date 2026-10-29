import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type { MCPServerStatus, Project, ProjectSession, SidebarProjectListProps } from '@/shared/types';

let isCompactLayout = false;

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => isCompactLayout,
}));

const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');

const project = {
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project one',
  fullPath: '/tmp/project-1',
  sessions: [],
} as unknown as Project;

const t = ((key: string) => key) as SidebarProjectListProps['t'];
const noop = () => {};

function renderProject(compact: boolean, withOpenSession = false) {
  isCompactLayout = compact;
  const onToggleProject = vi.fn();
  const onProjectSelect = vi.fn();
  const onNewSession = vi.fn();
  const onStartEditingProject = vi.fn();
  const onDeleteProject = vi.fn();
  const onToggleStarProject = vi.fn();

  render(
    <SidebarProjectItem
      project={project}
      selectedProject={withOpenSession ? { ...project, projectId: 'other-project' } : null}
      selectedSession={withOpenSession ? ({ id: 'open-session' } as ProjectSession) : null}
      isExpanded={false}
      isDeleting={false}
      isStarred={false}
      isEditing={false}
      renameDraft=""
      sessions={[]}
      initialSessionsLoaded={false}
      isLoadingMoreSessions={false}
      currentTime={new Date()}
      sessionRenameId={null}
      sessionRenameDraft=""
      tasksEnabled={false}
      mcpServerStatus={{} as MCPServerStatus}
      onRenameDraftChange={noop}
      onToggleProject={onToggleProject}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={onToggleStarProject}
      onStartEditingProject={onStartEditingProject}
      onCancelEditingProject={noop}
      onSaveProjectName={noop}
      onDeleteProject={onDeleteProject}
      onSessionSelect={noop}
      onDeleteSession={noop}
      onLoadMoreSessions={noop}
      activeSessions={new Set()}
      backgroundSessionIds={new Set()}
      attentionSessionIds={new Set()}
      onNewSession={onNewSession}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      selectedSessionIds={null}
      onSetSessionSelection={noop}
      onToggleSessionSelected={noop}
      onCancelSessionSelection={noop}
      onDeleteSelectedSessions={noop}
      t={t}
    />,
  );

  return { onToggleProject, onProjectSelect, onNewSession, onStartEditingProject, onDeleteProject, onToggleStarProject };
}

afterEach(() => {
  isCompactLayout = false;
});

test('desktop project card expands without changing the open session project', () => {
  const callbacks = renderProject(false, true);
  const card = screen.getByText('project one').closest('[role="button"]');
  assert.ok(card);

  fireEvent.click(card);
  fireEvent.keyDown(card, { key: 'Enter' });

  assert.deepEqual(callbacks.onToggleProject.mock.calls, [['project-1'], ['project-1']]);
  assert.equal(callbacks.onProjectSelect.mock.calls.length, 0);
});

for (const compact of [false, true]) {
  test(`${compact ? 'compact' : 'desktop'} project menu runs its actions without toggling the card`, () => {
    const callbacks = renderProject(compact);
    const trigger = screen.getByRole('button', { name: 'project one: projects.actions' });

    fireEvent.click(trigger);
    assert.equal(callbacks.onToggleProject.mock.calls.length, 0);
    fireEvent.click(screen.getByRole('menuitem', { name: 'sessions.newSession' }));
    assert.deepEqual(callbacks.onNewSession.mock.calls[0], [project]);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'projects.edit' }));
    assert.deepEqual(callbacks.onStartEditingProject.mock.calls[0], [project]);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'tooltips.addToFavorites' }));
    assert.deepEqual(callbacks.onToggleStarProject.mock.calls[0], ['project-1']);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'projects.delete' }));
    assert.deepEqual(callbacks.onDeleteProject.mock.calls[0], [project]);
    assert.equal(callbacks.onToggleProject.mock.calls.length, 0);
  });
}
