import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';

import { startIsolationEgress } from '@/modules/project-isolation/egress-proxy.service.js';
import { startIsolationSshAgent } from '@/modules/project-isolation/isolation-ssh.service.js';

const root = await fs.mkdtemp(path.join('/tmp', 'cloudcli-agent-'));
const host = path.join(root, 'host.sock'), relay = path.join(root, 'relay.sock');
const received: number[] = [];
const connections = new Set<net.Socket>();
const frame = (payload: Buffer) => { const header = Buffer.alloc(4); header.writeUInt32BE(payload.length); return Buffer.concat([header, payload]); };
const field = (value: string) => frame(Buffer.from(value));
const fake = net.createServer((socket) => {
  connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {});
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
    while (data.length >= 4 && data.length >= data.readUInt32BE(0) + 4) {
      const length = data.readUInt32BE(0); received.push(data[4]);
      socket.write(frame(Buffer.from([5]))); data = data.subarray(length + 4);
    }
  });
});
await new Promise<void>((resolve) => fake.listen(host, resolve));
const proxy = await startIsolationSshAgent(relay, host);
after(async () => { for (const connection of connections) connection.destroy(); await Promise.all([new Promise<void>((r) => proxy.close(() => r())), new Promise<void>((r) => fake.close(() => r()))]); await fs.rm(root, { recursive: true, force: true }); });

function send(payload: Buffer, fragmented = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relay); let response = Buffer.alloc(0);
    socket.setTimeout(2000, () => socket.destroy(new Error('Relay test timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk) => { response = Buffer.concat([response, chunk]); socket.destroy(); });
    socket.on('close', () => resolve(response));
    socket.on('connect', () => { const packet = frame(payload); if (fragmented) { socket.write(packet.subarray(0, 2)); socket.write(packet.subarray(2, 5)); socket.write(packet.subarray(5)); } else socket.write(packet); });
  });
}

test('relay forwards framed key listing and signing, including split packets', async () => {
  assert.equal((await send(Buffer.from([11]), true)).length, 5);
  const signing = Buffer.concat([Buffer.from([13]), field('public-key'), field('signing-challenge'), Buffer.alloc(4)]);
  assert.equal((await send(signing, true)).length, 5);
  assert.deepEqual(received.slice(-2), [11, 13]);
  assert.equal((await fs.stat(relay)).mode & 0o777, 0o600);
});

test('relay blocks add/remove identities and lock/unlock before they reach the host agent', async () => {
  const count = received.length;
  for (const type of [17, 18, 19, 20, 21, 22, 23, 25, 26, 99]) assert.equal((await send(Buffer.from([type]))).length, 0);
  assert.equal(received.length, count);
});

test('relay only forwards the known OpenSSH session-binding extension and rejects malformed requests', async () => {
  const count = received.length;
  const binding = Buffer.concat([Buffer.from([27]), field('session-bind@openssh.com'), field('host-key'), field('session-id'), field('signature'), Buffer.from([1])]);
  await send(binding);
  assert.equal(received.length, count + 1);
  for (const body of [Buffer.from([11, 0]), Buffer.from([13]), Buffer.concat([Buffer.from([27]), field('dangerous-extension')])]) assert.equal((await send(body)).length, 0);
  assert.equal(received.length, count + 1);
});

test('agent target must be an actual local Unix socket', async () => {
  const file = path.join(root, 'not-a-socket'); await fs.writeFile(file, 'ordinary file');
  await assert.rejects(startIsolationSshAgent(path.join(root, 'bad.sock'), file), /local SSH agent/);
});

test('relay rejects oversized and empty frames without forwarding them', async () => {
  const count = received.length;
  for (const body of [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1, 11)]) {
    assert.equal((await send(body).catch(() => Buffer.alloc(0))).length, 0);
  }
  assert.equal(received.length, count);
});


test('SSH-enabled egress refuses private destinations on standard and custom ports', async () => {
  const socketPath = path.join(root, 'ssh-egress.sock');
  const server = await startIsolationEgress(socketPath, { allowSsh: true });
  try {
    for (const destination of ['127.0.0.1:22', 'localhost:22', '10.0.0.1:22', '169.254.169.254:22', '[::1]:22', '127.0.0.1:223', '10.0.0.1:8080', '[::1]:65535', 'example.com:0', 'example.com:65536']) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({ socketPath, method: 'CONNECT', path: destination });
        request.once('connect', (response, connection) => { resolve(response.statusCode!); connection.destroy(); });
        request.once('error', reject); request.end();
      });
      assert.equal(status, 403, destination);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
