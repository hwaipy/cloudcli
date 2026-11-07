import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ContextMenuProvider } from '@/shared/ui';
import QueuedMessageCard from '@/modules/chat/transcript/QueuedMessageCard';

test('queued turn uses a user-message bubble and exposes its queue actions', () => {
  const onEdit = vi.fn();
  const onSteer = vi.fn();
  const onDelete = vi.fn();
  const onMoveUp = vi.fn();
  const onMoveDown = vi.fn();
  const onDragStart = vi.fn();
  const onDrop = vi.fn();
  const { getByRole, getByText, queryByRole, container } = render(
    <QueuedMessageCard
      content={'First line\n second line'}
      attachmentCount={2}
      position={2}
      total={3}
      isDropTarget={false}
      canSteer
      onEdit={onEdit}
      onSteer={onSteer}
      onDelete={onDelete}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      onDragStart={onDragStart}
      onDragOver={() => {}}
      onDrop={onDrop}
      onDragEnd={() => {}}
    />,
  );

  const bubble = container.querySelector('[class*="rounded-br-md"]');
  assert.equal(bubble?.className.includes('bg-muted/60'), true);
  assert.match(container.textContent ?? '', /First line\s+second line/);
  assert.equal(bubble?.querySelector('[class*="truncate"]'), null);
  assert.equal(container.textContent?.includes('2'), true);
  assert.equal(queryByRole('button', { name: 'Queued message actions' }), null);

  fireEvent.click(getByRole('button', { name: 'Edit queued message' }));
  fireEvent.click(getByRole('button', { name: 'Steer' }));
  fireEvent.click(getByRole('button', { name: 'Move queued message up' }));
  fireEvent.click(getByRole('button', { name: 'Move queued message down' }));
  fireEvent.click(getByRole('button', { name: 'Delete queued message' }));
  fireEvent.dragStart(getByRole('button', { name: 'Drag to reorder queued message 2' }));
  fireEvent.drop(container.firstElementChild!);

  assert.equal(onEdit.mock.calls.length, 1);
  assert.equal(onSteer.mock.calls.length, 1);
  assert.equal(onMoveUp.mock.calls.length, 1);
  assert.equal(onMoveDown.mock.calls.length, 1);
  assert.equal(onDelete.mock.calls.length, 1);
  assert.equal(onDragStart.mock.calls.length, 1);
  assert.equal(onDrop.mock.calls.length, 1);
});

test('reorder arrows are disabled at the ends of the queue', () => {
  const props = {
    content: 'Queued', position: 1, total: 3, isDropTarget: false, canSteer: false,
    onEdit: vi.fn(), onSteer: vi.fn(), onDelete: vi.fn(),
    onMoveUp: vi.fn(), onMoveDown: vi.fn(), onDragStart: vi.fn(),
    onDragOver: vi.fn(), onDrop: vi.fn(), onDragEnd: vi.fn(),
  };
  const view = render(<QueuedMessageCard {...props} />);
  assert.equal((view.getByRole('button', { name: 'Move queued message up' }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole('button', { name: 'Move queued message down' }) as HTMLButtonElement).disabled, false);

  view.rerender(<QueuedMessageCard {...props} position={3} />);
  assert.equal((view.getByRole('button', { name: 'Move queued message up' }) as HTMLButtonElement).disabled, false);
  assert.equal((view.getByRole('button', { name: 'Move queued message down' }) as HTMLButtonElement).disabled, true);
});

test('queued right-click exposes steer/edit/delete and disables movement at the ends', () => {
  const onSteer = vi.fn(); const onEdit = vi.fn(); const onDelete = vi.fn();
  const view = render(<ContextMenuProvider><QueuedMessageCard content="Context queue" position={1} total={1} isDropTarget={false} canSteer
    onSteer={onSteer} onEdit={onEdit} onDelete={onDelete} onMoveUp={() => {}} onMoveDown={() => {}} onDragStart={() => {}} onDragOver={() => {}} onDrop={() => {}} onDragEnd={() => {}} /></ContextMenuProvider>);
  fireEvent.contextMenu(view.getByText('Context queue'));
  assert.equal((view.getByRole('menuitem', { name: '上移' }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole('menuitem', { name: '下移' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole('menuitem', { name: 'Steer：立即追加指令' }));
  assert.equal(onSteer.mock.calls.length, 1);
  fireEvent.contextMenu(view.getByText('Context queue')); fireEvent.click(view.getByRole('menuitem', { name: '编辑排队消息' }));
  assert.equal(onEdit.mock.calls.length, 1);
  fireEvent.contextMenu(view.getByText('Context queue')); fireEvent.click(view.getByRole('menuitem', { name: '删除排队消息' }));
  assert.equal(onDelete.mock.calls.length, 1);
});
