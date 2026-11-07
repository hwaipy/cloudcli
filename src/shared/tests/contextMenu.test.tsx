import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ContextMenuProvider, useAppContextMenu } from '@/shared/ui/ContextMenu';

const writeText = vi.fn(async (_text: string) => {});
const readText = vi.fn(async () => 'pasted');
afterEach(() => { cleanup(); vi.restoreAllMocks(); writeText.mockClear(); readText.mockClear(); window.getSelection()?.removeAllRanges(); });
function clipboard() { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } }); }
function Scoped({ action = () => {} }: { action?: () => void }) {
  const open = useAppContextMenu();
  return <div data-testid="scope" onContextMenu={(event) => open(event, [{ key: 'specific', label: 'Scoped action', onSelect: action }, { key: 'disabled', label: 'Disabled action', onSelect: action, disabled: true }])}>
    <a href="https://example.com/file">Link</a><pre>const value = 1;</pre><input aria-label="draft" defaultValue="draft" />
  </div>;
}
test('scoped menus combine link actions, close on selection, and execute once', async () => {
  clipboard(); const action = vi.fn();
  render(<ContextMenuProvider><Scoped action={action} /></ContextMenuProvider>);
  fireEvent.contextMenu(screen.getByText('Link'), { clientX: 40, clientY: 30 });
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menuitem', { name: '在新标签页打开链接' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '复制链接地址' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/file'));
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.contextMenu(screen.getByTestId('scope'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled action' })); expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Scoped action' })); expect(action).toHaveBeenCalledTimes(1);
});
test('inputs override surrounding actions and clipboard paste updates a controlled field', async () => {
  clipboard();
  function Draft() {
    const open = useAppContextMenu();
    // Controlled text verifies the same change path as the composer.
    const [value, setValue] = useState('draft');
    return <div onContextMenu={(event) => open(event, [{ key: 'delete', label: 'Delete project', onSelect: () => {} }])}><textarea aria-label="controlled" value={value} onChange={(event) => setValue(event.target.value)} /><output>{value}</output></div>;
  }
  render(<ContextMenuProvider><Draft /></ContextMenuProvider>);
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  field.focus(); field.setSelectionRange(0, 5);
  fireEvent.contextMenu(field);
  expect(screen.queryByRole('menuitem', { name: 'Delete project' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('pasted'));
  expect(field.value).toBe('pasted');
});
test('password and readonly fields protect copy, cut and mutation appropriately', () => {
  clipboard();
  render(<ContextMenuProvider><input aria-label="password" type="password" defaultValue="secret" /><textarea aria-label="readonly" readOnly defaultValue="read" /></ContextMenuProvider>);
  const secret = screen.getByLabelText('password') as HTMLInputElement;
  secret.setSelectionRange(0, 6); fireEvent.contextMenu(secret);
  expect((screen.getByRole('menuitem', { name: '复制' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('menuitem', { name: '剪切' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.contextMenu(screen.getByLabelText('readonly'));
  expect((screen.getByRole('menuitem', { name: '粘贴' }) as HTMLButtonElement).disabled).toBe(true);
});
test('Escape restores focus, arrow navigation skips disabled items, and outside pointer closes', () => {
  render(<ContextMenuProvider><Scoped /></ContextMenuProvider>);
  const field = screen.getByLabelText('draft'); field.focus();
  fireEvent.contextMenu(screen.getByTestId('scope'));
  expect(document.activeElement).toBe(screen.getByRole('menu'));
  expect(screen.getAllByRole('menuitem').some((item) => item === document.activeElement)).toBe(false);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toBe('Scoped action');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(field);
  fireEvent.contextMenu(screen.getByTestId('scope'));
  fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
});
test('code and selected text retain separate copy actions; unsupported operations show errors', async () => {
  clipboard();
  render(<ContextMenuProvider><Scoped action={() => { throw new Error('Expected failure'); }} /></ContextMenuProvider>);
  const code = screen.getByText('const value = 1;');
  const range = document.createRange(); range.selectNodeContents(code); window.getSelection()?.addRange(range);
  fireEvent.contextMenu(code);
  expect(screen.getByRole('menuitem', { name: '复制代码' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '复制选中文字' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('const value = 1;'));
  window.getSelection()?.removeAllRanges();
  fireEvent.contextMenu(screen.getByTestId('scope')); fireEvent.click(screen.getByRole('menuitem', { name: 'Scoped action' }));
  expect(screen.getByRole('alert').textContent).toContain('Expected failure');
});
test('a delayed clipboard read cannot overwrite newer typing', async () => {
  clipboard(); let finish!: (text: string) => void;
  readText.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<ContextMenuProvider><textarea aria-label="draft" defaultValue="original" /></ContextMenuProvider>);
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  field.setSelectionRange(0, 8); fireEvent.contextMenu(field); fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }));
  fireEvent.change(field, { target: { value: 'new typing' } });
  await act(async () => finish('late clipboard'));
  expect(field.value).toBe('new typing'); expect(screen.getByRole('alert').textContent).toContain('输入内容已变化');
});

test('Escape dismisses the context menu before the containing dialog', async () => {
  const { Dialog, DialogContent } = await import('@/shared/ui/Dialog');
  function Modal() {
    // The dialog remains open after dismissing only its contextual menu.
    const [open, setOpen] = useState(true);
    return <Dialog open={open} onOpenChange={setOpen}><DialogContent><input aria-label="modal field" /></DialogContent></Dialog>;
  }
  render(<ContextMenuProvider><Modal /></ContextMenuProvider>);
  fireEvent.contextMenu(screen.getByLabelText('modal field'));
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('opening a context menu closes an existing overflow menu', async () => {
  const { ActionMenu } = await import('@/shared/ui/ActionMenu');
  render(<ContextMenuProvider><ActionMenu label="Overflow" items={[{ key: 'old', label: 'Old action', onSelect: () => {} }]} /><Scoped /></ContextMenuProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Overflow' }));
  expect(screen.getByRole('menuitem', { name: 'Old action' })).toBeTruthy();
  fireEvent.contextMenu(screen.getByTestId('scope'));
  expect(screen.queryByRole('menuitem', { name: 'Old action' })).toBeNull();
  expect(screen.getAllByRole('menu')).toHaveLength(1);
});

test('scoped actions replace generic actions with the same key instead of duplicating menu rows', () => {
  function SessionLink() {
    const open = useAppContextMenu();
    return <a href="/session/one" onContextMenu={(event) => open(event, [{ key: 'copy-link', label: '复制会话链接', onSelect: () => {} }])}>Session</a>;
  }
  render(<ContextMenuProvider><SessionLink /></ContextMenuProvider>);
  fireEvent.contextMenu(screen.getByText('Session'));
  expect(screen.getByRole('menuitem', { name: '复制会话链接' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: '复制链接地址' })).toBeNull();
});
