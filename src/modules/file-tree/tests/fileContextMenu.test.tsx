import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ContextMenuProvider } from '@/shared/ui';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';
import '@/modules/i18n';
afterEach(cleanup);
test('file context menu offers supported operations and uses existing callbacks', () => {
  const item = { name: 'file.ts', type: 'file' as const, path: '/tmp/file.ts' };
  const onRename = vi.fn(); const onCopyPath = vi.fn();
  render(<ContextMenuProvider><FileContextMenu item={item} onRename={onRename} onCopyPath={onCopyPath}><span>file.ts</span></FileContextMenu></ContextMenuProvider>);
  fireEvent.contextMenu(screen.getByText('file.ts'));
  expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  expect(onRename).toHaveBeenCalledWith(item);
});
test('loading file actions cannot execute', () => {
  const onDelete = vi.fn();
  render(<ContextMenuProvider><FileContextMenu item={{ name: 'file.ts', type: 'file', path: '/tmp/file.ts' }} isLoading onDelete={onDelete}><span>file.ts</span></FileContextMenu></ContextMenuProvider>);
  fireEvent.contextMenu(screen.getByText('file.ts'));
  const action = screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement;
  expect(action.disabled).toBe(true); fireEvent.click(action); expect(onDelete).not.toHaveBeenCalled();
});
