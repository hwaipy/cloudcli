import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * The Projects list draws a session's state as a dot on the row's left edge:
 * green when it has recent activity that has not been viewed. A session
 * whose turn has ended while the tasks it launched still run takes that slot
 * in the purple of the workflow and agent cards, saying what is still going
 * on — while the spinner and the destructive-action lockout stay reserved for
 * a response in flight.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];
const auth = vi.hoisted(() => ({ user: { id: 7, username: 'tester' } }));

vi.mock('@/modules/auth', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  useOptionalAuth: () => ({ user: auth.user }),
}));

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;
// Touched a minute ago, so the green "recently active" dot would apply.
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

type RowState = {
  isProcessing: boolean;
  hasBackgroundWork: boolean;
  selectedSession?: ProjectSession | null;
  session?: SessionWithProvider;
};

const rowProps = (state: RowState) => ({
    project: PROJECT,
    session: SESSION,
    selectedSession: null,
    currentTime: NOW,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
    ...state,
});

const renderRow = (state: RowState) => render(React.createElement(SidebarSessionItem, rowProps(state)));

beforeEach(() => {
  recordedOptionsProps.length = 0;
  localStorage.clear();
});

test('background work shows as the purple dot in place of the green one, with nothing spinning', () => {
  const idle = renderRow({ isProcessing: false, hasBackgroundWork: false });
  assert.ok(idle.container.querySelector('[role="status"].bg-green-500'), 'the fixture is a recently touched session');
  idle.unmount();

  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: true });

  const dot = container.querySelector('[role="status"]');
  assert.ok(dot);
  assert.ok(dot.className.includes('bg-purple-500'));
  assert.ok(!dot.className.includes('bg-green-500'));
  assert.equal(dot.getAttribute('aria-label'), 'tooltips.backgroundWorkIndicator');
  assert.equal(container.querySelectorAll('.animate-spin').length, 0);
  assert.equal(recordedOptionsProps.at(-1)?.isProcessing, false, 'the row is not locked the way a responding one is');
});

test('a response in flight still spins and shows no dot', () => {
  const { container } = renderRow({ isProcessing: true, hasBackgroundWork: false });

  assert.equal(container.querySelector('[role="status"]'), null);
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
  assert.equal(recordedOptionsProps[0].isProcessing, true);
});

test('the green dot appears after a recent session stops processing', () => {
  const row = renderRow({ isProcessing: true, hasBackgroundWork: false });
  assert.equal(row.container.querySelector('[role="status"]'), null);

  row.rerender(React.createElement(SidebarSessionItem, rowProps({ isProcessing: false, hasBackgroundWork: false })));

  assert.ok(row.container.querySelector('[role="status"].bg-green-500'));
  assert.equal(row.container.querySelector('.bg-amber-500'), null);
});

test('opening a completed session clears its green dot until newer activity arrives', () => {
  const row = renderRow({ isProcessing: false, hasBackgroundWork: false });
  const initialDot = row.container.querySelector('[role="status"].bg-green-500');
  assert.ok(initialDot);
  assert.match(initialDot.parentElement?.parentElement?.className ?? '', /top-1\/2.*h-2 w-2/);

  const base = { isProcessing: false, hasBackgroundWork: false };
  row.rerender(React.createElement(SidebarSessionItem, rowProps({ ...base, selectedSession: SESSION })));
  assert.equal(row.container.querySelector('[role="status"].bg-green-500'), null);
  assert.equal(localStorage.getItem('cloudcli-seen-session:7:s1'), SESSION.lastActivity);
  row.rerender(React.createElement(SidebarSessionItem, rowProps(base)));
  assert.equal(row.container.querySelector('[role="status"].bg-green-500'), null);

  row.unmount();
  const reopened = renderRow(base);
  assert.equal(reopened.container.querySelector('[role="status"].bg-green-500'), null);

  reopened.rerender(React.createElement(SidebarSessionItem, rowProps({
    ...base,
    session: { ...SESSION, lastActivity: '2026-08-21T10:00:00.000Z' },
  })));
  assert.ok(reopened.container.querySelector('[role="status"].bg-green-500'));
});
