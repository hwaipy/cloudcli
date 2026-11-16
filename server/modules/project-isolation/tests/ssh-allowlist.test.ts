import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startIsolationEgress } from '../egress-proxy.service.js';

test('private SSH grants require the project credential and exact destination; HTTP proxy remains blocked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ssh-'));
  const socketPath = path.join(root, '.egress', 'ssh.sock');
  const target = net.createServer(socket => socket.end('SSH-2.0-allowlist-test\r\n'));
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const port = (target.address() as net.AddressInfo).port;
  const token = 'a'.repeat(64);
  await fs.writeFile(path.join(root, 'ssh-allowlist.json'), JSON.stringify({
    projectA: { token, destinations: [{ address: '127.0.0.1', port }] },
    projectB: { token: 'b'.repeat(64), destinations: [{ address: '127.0.0.2', port }] },
  }));
  const proxy = await startIsolationEgress(socketPath, { allowSsh: true });
  const connect = (destination: string, credential?: string) => new Promise<{ code: number; text: string }>((resolve, reject) => {
    const request = http.request({ socketPath, method: 'CONNECT', path: destination,
      headers: credential ? { 'Proxy-Authorization': `Bearer ${credential}` } : {} });
    request.on('error', reject);
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); resolve({ code: response.statusCode!, text: '' }); return; }
      let text = head.toString(); socket.on('data', chunk => { text += chunk; });
      socket.on('end', () => { socket.destroy(); resolve({ code: 200, text }); });
    });
    request.end();
  });
  try {
    for (const credential of [undefined, 'x'.repeat(64), 'b'.repeat(64)]) assert.equal((await connect(`127.0.0.1:${port}`, credential)).code, 403);
    assert.equal((await connect(`127.0.0.1:${port + 1}`, token)).code, 403);
    assert.equal((await connect(`localhost:${port}`, token)).code, 403);
    const accepted = await connect(`127.0.0.1:${port}`, token);
    assert.equal(accepted.code, 200); assert.match(accepted.text, /SSH-2.0-allowlist-test/);
    const httpCode = await new Promise<number>((resolve, reject) => {
      const request = http.get({ socketPath, path: 'http://127.0.0.1/', headers: { 'Proxy-Authorization': `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject);
    });
    assert.equal(httpCode, 403);
    await fs.writeFile(path.join(root, 'ssh-allowlist.json'), '{}');
    assert.equal((await connect(`127.0.0.1:${port}`, token)).code, 403, 'revocation is read without restarting the broker');
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
