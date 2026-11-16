import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useWebPush } from '@/modules/settings/hooks/useWebPush';

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({ ok: true, json: async () => ({ backends: [{ id: 'mac' }, { id: 'vm' }, { id: 'offline', online: false }] }) })),
  key: vi.fn(async () => ({ ok: true, json: async () => ({ publicKey: 'AQID' }) })),
  subscribe: vi.fn(async () => ({ ok: true })), unsubscribe: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/shared/api', () => ({ api: { hub: { backends: api.list }, settings: { push: { vapidPublicKey: api.key, subscribe: api.subscribe, unsubscribe: api.unsubscribe } } } }));
vi.mock('@/shared/utils', () => ({ isHubRuntime: () => true }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'cloudcliDesktopUpdates'); vi.clearAllMocks(); });
function worker() {
  const registrations: any[] = [];
  const register = vi.fn(async (_script: string, options: { scope: string }) => {
    const subscription = { endpoint: options.scope, toJSON: () => ({ endpoint: options.scope, keys: {} }), unsubscribe: vi.fn(async () => true) };
    const registration = { scope: new URL(options.scope, window.location.href).href, active: {},
      pushManager: { getSubscription: vi.fn(async () => null as unknown), subscribe: vi.fn(async () => subscription) } };
    registrations.push(registration); return registration;
  });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
  vi.stubGlobal('navigator', { serviceWorker: { register, getRegistrations: vi.fn(async () => registrations) } });
  return { registrations, register };
}
test('browser subscribes once per online backend using independent service-worker scopes and VAPID keys', async () => {
  const { register } = worker(); const hook = renderHook(() => useWebPush());
  await act(async () => { await hook.result.current.subscribe(); });
  expect(register).toHaveBeenCalledTimes(2);
  expect(register.mock.calls.map(call => call[1].scope)).toEqual(['/push/mac/', '/push/vm/']);
  expect(api.subscribe).toHaveBeenNthCalledWith(1, expect.any(Object), 'mac');
  expect(api.subscribe).toHaveBeenNthCalledWith(2, expect.any(Object), 'vm');
  expect(hook.result.current.isSubscribed).toBe(true);
});
test('Electron never waits for a service worker or subscribes browser push', async () => {
  const { register } = worker(); Object.defineProperty(window, 'cloudcliDesktopUpdates', { configurable: true, value: {} });
  const hook = renderHook(() => useWebPush()); await act(async () => { await hook.result.current.subscribe(); });
  expect(hook.result.current.permission).toBe('unsupported'); expect(register).not.toHaveBeenCalled();
});
