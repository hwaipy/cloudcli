import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useDesktopNotifications } from '@/modules/desktop-notifications';
import type { DesktopNotificationState, DesktopNotificationTarget } from '@/shared/types';

const fake = vi.hoisted(() => ({
  auth: { user: { id: 'user-a', username: 'a' }, token: 'fixture-token' },
  register: vi.fn(async (_endpoint: string, _enabled: boolean, _backend?: string) => ({ ok: true })),
  backends: vi.fn(async () => ({ ok: true, json: async () => ({ backends: [{ id: 'mac' }, { id: 'vm' }] }) })),
  ownership: vi.fn(),
}));
vi.mock('@/modules/auth', () => ({ useAuth: () => fake.auth }));
vi.mock('@/shared/api', () => ({ api: { hub: { backends: fake.backends }, desktopNotifications: {
  register: fake.register, socketUrl: (_token: string, backend: string) => `wss://fixture.invalid/${backend}`,
} } }));
vi.mock('@/shared/utils', () => ({ isHubRuntime: () => true, getHubResourceBackend: () => 'mac', registerHubResourceBackend: fake.ownership }));
class Socket {
  static OPEN = 1; static sockets: Socket[] = [];
  readyState = 1; sent: string[] = []; closed = false;
  onopen?: () => Promise<void>; onmessage?: (event: { data: string }) => Promise<void>; onclose?: () => void;
  constructor(readonly url: string) { Socket.sockets.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; this.onclose?.(); }
}
function bridge() {
  let state: DesktopNotificationState = { desktopNotifications: { enabled: true, supported: true, unreadCount: 0 } };
  let listener: (value: DesktopNotificationState) => void = () => {};
  let navigate: (value: DesktopNotificationTarget) => void = () => {};
  const native = { scope: vi.fn(async (_account: string) => state), receive: vi.fn(async () => true), active: vi.fn(async () => {}),
    onStateUpdated: (next: typeof listener) => { listener = next; return vi.fn(); },
    onNavigate: (next: typeof navigate) => { navigate = next; return vi.fn(); },
  };
  Object.defineProperty(window, 'cloudcliDesktopNotifications', { configurable: true, value: native });
  return { native, disable: () => { state = { desktopNotifications: { enabled: false, supported: true, unreadCount: 0 } }; listener(state); }, navigate: (value: DesktopNotificationTarget) => navigate(value) };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'cloudcliDesktopNotifications'); Socket.sockets = []; vi.clearAllMocks(); });

test('connects each backend independently; notification delivery is independent of selected session', async () => {
  vi.stubGlobal('WebSocket', Socket); const { native } = bridge();
  const { unmount } = renderHook(() => useDesktopNotifications('selected', vi.fn()));
  await waitFor(() => expect(Socket.sockets.length).toBe(2));
  for (const socket of Socket.sockets) await act(async () => { await socket.onopen?.(); });
  expect(fake.register.mock.calls.map(call => call[2]).sort()).toEqual(['mac', 'vm']);
  await act(async () => { await Socket.sockets[1].onmessage?.({ data: JSON.stringify({ type: 'notification', id: 'event', payload: { title: 'VM done', data: { sessionId: 'another' } } }) }); });
  expect(native.receive).toHaveBeenCalledWith(expect.objectContaining({ backendId: 'vm', id: 'event' }));
  expect(fake.ownership).toHaveBeenCalledWith('session', 'another', 'vm');
  const sockets = [...Socket.sockets]; unmount(); expect(sockets.every(socket => socket.closed)).toBe(true);
});
test('device disable closes all connections and updates this device only; clicks retain backend identity', async () => {
  vi.stubGlobal('WebSocket', Socket); const control = bridge(); const navigate = vi.fn();
  renderHook(() => useDesktopNotifications('selected', navigate));
  await waitFor(() => expect(Socket.sockets.length).toBe(2));
  act(() => control.navigate({ sessionId: 'q', backendId: 'vm' }));
  expect(navigate).toHaveBeenCalledWith({ sessionId: 'q', backendId: 'vm' });
  act(() => control.disable());
  expect(Socket.sockets.every(socket => socket.closed)).toBe(true);
  expect(fake.register).toHaveBeenCalledWith(expect.any(String), false, 'vm');
});
test('ordinary browser creates no Electron notification connections', async () => {
  vi.stubGlobal('WebSocket', Socket); renderHook(() => useDesktopNotifications(null, vi.fn()));
  await act(async () => {}); expect(Socket.sockets.length).toBe(0); expect(fake.register).not.toHaveBeenCalled();
});
test('switching the viewed session updates native read state without recreating backend connections', async () => {
  vi.stubGlobal('WebSocket', Socket); const { native } = bridge(); const navigate = vi.fn();
  const hook = renderHook(({ selected }: { selected: string | null }) => useDesktopNotifications(selected, navigate), { initialProps: { selected: 'first' as string | null } });
  await waitFor(() => expect(Socket.sockets.length).toBe(2));
  hook.rerender({ selected: 'second' });
  expect(native.active).toHaveBeenLastCalledWith({ sessionId: 'second', backendId: 'mac' });
  hook.rerender({ selected: null });
  expect(native.active).toHaveBeenLastCalledWith({ sessionId: null, backendId: '' });
  expect(Socket.sockets.length).toBe(2);
});
test('refreshing the same account token preserves native unread state; unmount clears account scope', async () => {
  vi.stubGlobal('WebSocket', Socket); const { native } = bridge(); const navigate = vi.fn();
  const hook = renderHook(({ token }: { token: string }) => {
    fake.auth.token = token; useDesktopNotifications('selected', navigate);
  }, { initialProps: { token: 'fixture-token' } });
  await waitFor(() => expect(Socket.sockets.length).toBe(2));
  hook.rerender({ token: 'fixture-refreshed' });
  await waitFor(() => expect(Socket.sockets.length).toBe(4));
  expect(native.scope.mock.calls.some(call => call[0] === '')).toBe(false);
  hook.unmount(); expect(native.scope).toHaveBeenLastCalledWith('');
  fake.auth.token = 'fixture-token';
});
