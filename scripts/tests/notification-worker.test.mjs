import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = {}; const shown = []; const opened = [];
  const self = { location: { href: 'https://fixture.invalid/cloudcli/sw.js', origin: 'https://fixture.invalid' },
    registration: { scope: 'https://fixture.invalid/cloudcli/push/vm/', showNotification: async (title, options) => { shown.push({ title, options }); } },
    addEventListener: (name, callback) => { handlers[name] = callback; },
    clients: { matchAll: async () => [], openWindow: async url => { opened.push(url); } },
  };
  vm.runInNewContext(source, { self, URL });
  return { handlers, shown, opened };
}
test('Web Push derives backend identity from its scope and uses /cloudcli assets', async () => {
  const f = fixture(); let pending;
  f.handlers.push({ data: { json: () => ({ title: 'Done', data: { sessionId: 'test-session' } }) }, waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(f.shown[0].options.data.backendId, 'vm');
  assert.equal(f.shown[0].options.icon, 'https://fixture.invalid/cloudcli/logo-256.png');
});
test('notification click opens a session under the app subpath and preserves backend routing', async () => {
  const f = fixture(); let pending; let closed = false;
  f.handlers.notificationclick({ notification: { data: { sessionId: 'test-session', backendId: 'vm' }, close() { closed = true; } }, waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(closed, true); assert.equal(f.opened[0], '/cloudcli/session/test-session?hub_backend=vm');
});
