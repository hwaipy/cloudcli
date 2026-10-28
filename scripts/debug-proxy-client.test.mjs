import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('debug transport and storage remain separate from production', async () => {
  class Storage {
    values = new Map([['auth-token', 'production']]);
    get length() { return this.values.size; }
    key(i) { return [...this.values.keys()][i]; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
    clear() { this.values.clear(); }
  }
  class Socket { constructor(url) { this.url = url; } }
  class XHR { open(method, url) { this.url = url; } }
  const calls = [];
  const window = { fetch: (...args) => calls.push(args), WebSocket: Socket, EventSource: Socket };
  const navigator = { serviceWorker: { register: (...args) => calls.push(args) } };
  vm.runInNewContext(readFileSync(new URL('./debug-proxy-client.js', import.meta.url), 'utf8'), {
    window, navigator, Storage, XMLHttpRequest: XHR, URL, Request,
    location: { href: 'https://ai.hwaipy.cn/cloudcli/', host: 'ai.hwaipy.cn' },
  });
  window.fetch('/api/auth/status');
  assert.equal(calls.at(-1)[0], 'https://ai.hwaipy.cn/cloudcli/api/auth/status');
  window.fetch('https://example.com/api/test');
  assert.equal(calls.at(-1)[0], 'https://example.com/api/test');
  window.fetch(new Request('https://ai.hwaipy.cn/api/test', {method: 'POST', body: 'payload'}));
  assert.equal(calls.at(-1)[0].url, 'https://ai.hwaipy.cn/cloudcli/api/test');
  assert.equal(await calls.at(-1)[0].text(), 'payload');
  assert.equal(new window.WebSocket('wss://ai.hwaipy.cn/ws?token=test').url,
    'wss://ai.hwaipy.cn/cloudcli/ws?token=test');
  assert.equal(new window.WebSocket('wss://ai.hwaipy.cn/cloudcli/?token=test').url,
    'wss://ai.hwaipy.cn/cloudcli/?token=test');
  const storage = new Storage();
  assert.equal(storage.getItem('auth-token'), null);
  storage.setItem('auth-token', 'debug');
  assert.equal(storage.getItem('auth-token'), 'debug');
  assert.equal(storage.values.get('auth-token'), 'production');
  storage.clear();
  assert.equal(storage.values.get('auth-token'), 'production');
  assert.equal(storage.getItem('auth-token'), null);
  navigator.serviceWorker.register('/sw.js');
  assert.equal(calls.at(-1)[0], '/cloudcli/debug-sw.js');
});
