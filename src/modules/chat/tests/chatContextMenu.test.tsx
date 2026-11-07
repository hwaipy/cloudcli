import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ContextMenuProvider } from '@/shared/ui';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import type { ChatMessage } from '@/shared/types';
afterEach(cleanup);
test('anchored user messages offer editing but no fork', () => {
  const onEdit = vi.fn(); const onFork = vi.fn();
  const message: ChatMessage = { type: 'user', content: 'Context message', timestamp: 1, transcriptAnchorId: 'user-anchor' };
  render(<UiPreferencesProvider><ContextMenuProvider><MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" onEditMessage={onEdit} onForkFromMessage={onFork} /></ContextMenuProvider></UiPreferencesProvider>);
  fireEvent.contextMenu(screen.getByText('Context message'));
  fireEvent.click(screen.getByRole('menuitem', { name: '编辑并重新发送…' }));
  expect(onEdit).toHaveBeenCalledWith(message);
  fireEvent.contextMenu(screen.getByText('Context message'));
  expect(screen.queryByRole('menuitem', { name: /分叉/ })).toBeNull();
  expect(onFork).not.toHaveBeenCalled();
});
test('assistant messages do not expose destructive user-message controls', () => {
  render(<UiPreferencesProvider><ContextMenuProvider><MessageComponent message={{ type: 'assistant', content: 'Assistant answer', timestamp: 1 }} prevMessage={null} createDiff={() => []} provider="codex" onEditMessage={() => {}} onForkFromMessage={() => {}} /></ContextMenuProvider></UiPreferencesProvider>);
  fireEvent.contextMenu(screen.getByText('Assistant answer'));
  expect(screen.getByRole('menuitem', { name: '复制消息' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: '编辑并重新发送…' })).toBeNull();
});


test('a completed answer offers the round-end fork in its footer and context menu', () => {
  const onFork = vi.fn();
  const message: ChatMessage = { type: 'assistant', content: 'Completed answer', timestamp: 1, forkAnchorId: 'completed-turn' };
  render(<UiPreferencesProvider><ContextMenuProvider><MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" onForkFromMessage={onFork} /></ContextMenuProvider></UiPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: /分叉至本轮结束|Fork through this completed round/ }));
  expect(onFork).toHaveBeenCalledWith(message);
  fireEvent.contextMenu(screen.getByText('Completed answer'));
  fireEvent.click(screen.getByRole('menuitem', { name: '分叉至本轮结束…' }));
  expect(onFork).toHaveBeenCalledTimes(2);
});
