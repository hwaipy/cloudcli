import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { DesktopUpdateButton } from '@/modules/desktop-updates/DesktopUpdateButton';
import type { DesktopUpdateBridge, DesktopUpdateState } from '@/shared/types';
const idle: DesktopUpdateState = { web: { phase: 'idle' }, shell: { phase: 'idle' }, version: '0.1.0', packaged: false };
afterEach(() => { cleanup(); delete (window as Window & { cloudcliDesktopUpdates?: DesktopUpdateBridge }).cloudcliDesktopUpdates; });
function bridge(initial = idle) {
  let listener: ((value: DesktopUpdateState) => void) | undefined;
  const check = vi.fn(async () => idle);
  const apply = vi.fn(async () => {}); const unsubscribe = vi.fn();
  Object.defineProperty(window, 'cloudcliDesktopUpdates', { configurable: true, value: { state: async () => initial, check, apply, onState: (next: typeof listener) => { listener = next; return unsubscribe; } } });
  return { check, apply, unsubscribe, emit: (state: DesktopUpdateState) => act(() => listener?.(state)) };
}
test('ordinary browsers render exactly no desktop UI', () => {
  const view = render(<DesktopUpdateButton />); expect(view.container.childElementCount).toBe(0);
});
test('downloads in background, exposes update only when ready, and invokes native apply on click', async () => {
  const native = bridge(); const view = render(<DesktopUpdateButton />);
  await act(async () => {}); expect(screen.queryByRole('button')).toBeNull();
  native.emit({ ...idle, web: { phase: 'downloading', percent: 35 } });
  expect((screen.getByRole('button', { name: '正在下载更新' }) as HTMLButtonElement).disabled).toBe(true);
  native.emit({ ...idle, web: { phase: 'ready' } });
  fireEvent.click(screen.getByRole('button', { name: '更新并重启' }));
  expect(native.apply).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: '正在重启…' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount(); expect(native.unsubscribe).toHaveBeenCalled();
});
test('shell readiness shares the same button and a failed apply stays retryable', async () => {
  const native = bridge({ ...idle, shell: { phase: 'ready', version: '0.2.0' } }); native.apply.mockRejectedValueOnce(new Error('test failure'));
  render(<DesktopUpdateButton />);
  await waitFor(() => expect(screen.getByRole('button', { name: '更新并重启' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '更新并重启' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '更新并重启' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('button').title).toContain('test failure');
});


test('one icon exposes both update channels and waits while either still downloads', async () => {
  bridge({ ...idle, web: { phase: 'ready' }, shell: { phase: 'downloading', percent: 67, version: '0.2.0' } });
  render(<DesktopUpdateButton />);
  const button = await screen.findByRole('button', { name: '正在下载更新' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.title).toContain('网页资源：已下载');
  expect(button.title).toContain('桌面壳：下载中 67%');
  expect(button.querySelector('.lucide-download')).toBeTruthy();
  expect(button.title).toContain('67%');
});

test('unknown download size uses the same quiet download icon', async () => {
  bridge({ ...idle, web: { phase: 'downloading' } });
  render(<DesktopUpdateButton />);
  const button = await screen.findByRole('button', { name: '正在下载更新' });
  expect(button.textContent).toBe('');
  expect(button.querySelector('.lucide-download')).toBeTruthy();
});


test('idle and check errors alone leave no update button; rollback hides a previous ready state', async () => {
  const native = bridge();
  render(<DesktopUpdateButton />);
  await act(async () => {});
  expect(screen.queryByRole('button')).toBeNull();
  native.emit({ ...idle, web: { phase: 'error', error: 'fixture network error' } });
  expect(screen.queryByRole('button')).toBeNull();
  native.emit({ ...idle, web: { phase: 'ready' } });
  expect(screen.getByRole('button', { name: '更新并重启' }).querySelector('.lucide-circle-arrow-up')).toBeTruthy();
  native.emit(idle);
  expect(screen.queryByRole('button')).toBeNull();
  expect(native.check).not.toHaveBeenCalled();
  expect(native.apply).not.toHaveBeenCalled();
});


test('download progress changes only the hover details, never the icon', async () => {
  const native = bridge({ ...idle, web: { phase: 'downloading', percent: 12 } });
  render(<DesktopUpdateButton />);
  const button = await screen.findByRole('button', { name: '正在下载更新' });
  const icon = button.innerHTML;
  expect(button.title).toContain('12%');
  expect(button.querySelector('circle')).toBeNull();
  expect(button.querySelector('.animate-pulse, .animate-spin')).toBeNull();
  native.emit({ ...idle, web: { phase: 'downloading', percent: 89 } });
  expect(button.innerHTML).toBe(icon);
  expect(button.title).toContain('89%');
  expect(button.textContent).toBe('');
  native.emit({ ...idle, web: { phase: 'ready' } });
  expect(button.querySelector('.lucide-circle-arrow-up')).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
