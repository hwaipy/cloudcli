import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startIsolationEgress } from '../egress-proxy.service.js';

test('explicit upstream pins public targets, preserves tunnel bytes and never receives private targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'egress-upstream-'));
  const prior = process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY;
  const connections = new Set<net.Socket>();
  const destinations: string[] = [];
  const upstream = http.createServer();
  upstream.on('connection', (socket) => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  upstream.on('connect', (request, socket) => {
    destinations.push(request.url!);
    if (request.url!.endsWith(':444')) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    if (request.url!.endsWith(':80')) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        assert.match(data.toString(), /Host: 1\.1\.1\.1/i);
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied');
      });
    } else {
      // Include immediate SSH/banner bytes in the same packet as the CONNECT response.
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nbanner');
      socket.on('data', (data) => socket.write(data));
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as net.AddressInfo).port;
  process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY = `http://127.0.0.1:${port}`;
  const socketPath = path.join(root, 'proxy.sock');
  const proxy = await startIsolationEgress(socketPath, { allowSsh: true });
  const normalPath = path.join(root, 'normal.sock');
  const normal = await startIsolationEgress(normalPath);
  t.after(async () => {
    if (prior === undefined) delete process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY; else process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY = prior;
    for (const socket of connections) socket.destroy();
    await Promise.all([proxy, normal, upstream].map((server) => new Promise<void>((r) => server.close(() => r()))));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function exchange(frame: string, expected: RegExp, target = socketPath): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(target); let body = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Test timeout')));
      socket.on('connect', () => socket.write(frame));
      socket.on('error', reject);
      socket.on('data', (chunk) => { body += chunk; if (expected.test(body)) { socket.destroy(); resolve(body); } });
      socket.on('close', () => resolve(body));
    });
  }
  await t.test('TLS and arbitrary SSH ports use pinned CONNECT and preserve initial bytes', async () => {
    for (const port of [443, 223]) {
      const result = await exchange(`CONNECT 1.1.1.1:${port} HTTP/1.1\r\nHost: 1.1.1.1:${port}\r\n\r\npayload`, /bannerpayload/);
      assert.match(result, /200 Connection Established\r\n\r\nbannerpayload/);
      assert.equal(destinations.at(-1), `1.1.1.1:${port}`);
    }
  });
  await t.test('HTTP resources also use the configured tunnel', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ socketPath, path: 'http://1.1.1.1/style.css' }, (response) => { let data = ''; response.on('data', (chunk) => data += chunk); response.on('end', () => resolve(data)); }).on('error', reject);
    });
    assert.equal(body, 'proxied');
    assert.equal(destinations.at(-1), '1.1.1.1:80');
  });
  await t.test('private addresses and normal-proxy custom ports never reach upstream', async () => {
    const count = destinations.length;
    for (const address of ['127.0.0.1', '192.168.5.2', '169.254.169.254', '[::1]']) {
      assert.match(await exchange(`CONNECT ${address}:443 HTTP/1.1\r\n\r\n`, /403/), /403 Forbidden/);
    }
    assert.match(await exchange('CONNECT 1.1.1.1:223 HTTP/1.1\r\n\r\n', /403/, normalPath), /403 Forbidden/);
    assert.equal(destinations.length, count);
  });
  await t.test('upstream refusal fails closed without reporting an established tunnel', async () => {
    const result = await exchange('CONNECT 1.1.1.1:444 HTTP/1.1\r\n\r\n', /403/);
    assert.doesNotMatch(result, /200 Connection Established/);
    assert.match(result, /403/);
  });
  await t.test('unavailable upstream never falls back to a direct public connection', async () => {
    upstream.close();
    assert.doesNotMatch(await exchange('CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n', /403/), /200 Connection Established/);
  });
  await t.test('invalid operator proxy configuration is rejected at startup', async () => {
    for (const value of ['socks5://localhost:7897', 'http://user:secret@localhost:7897', 'http://localhost:7897/path']) {
      process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY = value;
      await assert.rejects(startIsolationEgress(path.join(root, 'invalid.sock')), /upstream/);
    }
  });
});
