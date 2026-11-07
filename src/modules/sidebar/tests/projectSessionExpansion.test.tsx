import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import type { SessionWithProvider } from '@/shared/types';

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({ default: ({ session }: { session: SessionWithProvider }) => <div data-testid="session-row">{session.id}</div> }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));
afterEach(cleanup);
function props(count: number): ComponentProps<typeof SidebarProjectSessions> {
  const noop = () => {};
  return {
    project: { projectId: 'p', displayName: 'Project', fullPath: '/tmp/p' }, isExpanded: true,
    sessions: Array.from({ length: count }, (_, i) => ({ id: `session-${i}`, __provider: 'codex' })),
    selectedSession: null, initialSessionsLoaded: true, hasMoreSessions: false, isLoadingMoreSessions: false,
    activeSessions: new Set(), backgroundSessionIds: new Set(), currentTime: new Date(),
    sessionRenameId: null, sessionRenameDraft: '', onRenameDraftChange: noop, onStartEditingSession: noop,
    onCancelEditingSession: noop, onSaveEditingSession: noop, onProjectSelect: noop, onSessionSelect: noop,
    onDeleteSession: noop, onLoadMoreSessions: vi.fn(), selectedSessionIds: null, onSetSessionSelection: noop,
    onToggleSessionSelected: noop, onCancelSessionSelection: noop, onDeleteSelectedSessions: noop,
    t: ((key: string) => key) as ComponentProps<typeof SidebarProjectSessions>['t'],
  };
}
test('large projects reveal a 3.5-row masked preview and all rows without a collapse button', () => {
  const view = render(<SidebarProjectSessions {...props(12)} />);
  const preview = view.container.querySelector('[data-session-expansion="preview"]') as HTMLElement;
  expect(preview.style.maxHeight).toBe('calc(3.5 * 2.1rem)');
  expect(preview.style.maskImage).toContain('linear-gradient');
  expect(screen.getAllByTestId('session-row')).toHaveLength(4);
  expect(preview.lastElementChild?.hasAttribute('inert')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '展开全部会话' }));
  expect(screen.getAllByTestId('session-row')).toHaveLength(12);
  expect(view.container.querySelector('[data-session-expansion="full"]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '收起至 3 条' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开全部会话' })).toBeNull();
});
test('three or fewer sessions need no intermediate stage; closed projects are inert during the height transition', () => {
  const p = props(3); const view = render(<SidebarProjectSessions {...p} />);
  expect(screen.getAllByTestId('session-row')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: '展开全部会话' })).toBeNull();
  view.rerender(<SidebarProjectSessions {...p} isExpanded={false} />);
  const closed = view.container.querySelector('[data-project-session-transition]') as HTMLElement;
  expect(closed.style.gridTemplateRows).toBe('0fr');
  expect(closed.getAttribute('aria-hidden')).toBe('true');
  expect(closed.hasAttribute('inert')).toBe(true);
});
test('full expansion follows pagination and does not endlessly retry a failed page', () => {
  const p = { ...props(8), hasMoreSessions: true };
  const view = render(<SidebarProjectSessions {...p} />);
  expect(p.onLoadMoreSessions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '展开全部会话' }));
  expect(p.onLoadMoreSessions).toHaveBeenCalledTimes(1);
  view.rerender(<SidebarProjectSessions {...p} isLoadingMoreSessions />);
  view.rerender(<SidebarProjectSessions {...p} />);
  expect(p.onLoadMoreSessions).toHaveBeenCalledTimes(1);
  view.rerender(<SidebarProjectSessions {...p} sessions={props(16).sessions} />);
  expect(p.onLoadMoreSessions).toHaveBeenCalledTimes(2);
});

test('four sessions already trigger the 3.5-row preview', () => {
  const view = render(<SidebarProjectSessions {...props(4)} />);
  expect(view.container.querySelector('[data-session-expansion="preview"]')).toBeTruthy();
  expect(screen.getByRole('button', { name: '展开全部会话' })).toBeTruthy();
});
