import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { createHubServer, loadHubConfiguration } from '@/modules/hub/index.js';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return address.port;
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-test-'));
  const distDirectory = path.join(directory, 'dist');
  const publicDirectory = path.join(directory, 'public');
  await fs.mkdir(distDirectory);
  await fs.mkdir(publicDirectory);
  await fs.writeFile(path.join(distDirectory, 'index.html'), '<html><head><link href="/favicon.svg"><script src="/cloudcli/assets/main.js"></script></head><body></body></html>');
  await fs.writeFile(path.join(publicDirectory, 'favicon.svg'), '<svg/>');
  await fs.writeFile(path.join(publicDirectory, 'manifest.json'), '{"start_url":"/","scope":"/","icons":[{"src":"/icons/icon.png"}]}');
  await fs.writeFile(path.join(publicDirectory, 'sw.js'), "const urlsToCache = ['/manifest.json'];");
  const backends = await Promise.all(['office', 'lab'].map(async (id) => {
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith('/api/upload')) {
        let body = '';
        request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        request.on('end', () => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ id, body }));
        });
        return;
      }
      if (request.url === '/api/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${id}-first\n\n`);
        setTimeout(() => response.end(`data: ${id}-second\n\n`), 10);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id, path: request.url, cookie: request.headers.cookie ?? '' }));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => socket.on('message', (message) => socket.send(`${id}:${message}`)));
    return { id, server, sockets, port: await listen(server) };
  }));
  const hub = createHubServer({
    backends: backends.map(({ id, port }) => ({ id, name: id, url: new URL(`http://127.0.0.1:${port}`) })),
    defaultBackendId: 'office',
    distDirectory,
    publicDirectory,
    basePath: '/cloudcli',
  });
  const port = await listen(hub);
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await Promise.all(backends.map(async ({ sockets, server }) => {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }));
      await new Promise<void>((resolve) => hub.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('Hub selects a fixed backend and keeps API, streams, and static frontend on one origin', async () => {
  const hub = await fixture();
  try {
    const defaultResponse = await fetch(`${hub.url}/api/projects`);
    assert.equal((await defaultResponse.json() as { id: string }).id, 'office');

    const selected = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lab' }),
    });
    assert.equal(selected.status, 200);
    const cookie = selected.headers.get('set-cookie')?.split(';')[0];
    assert.equal(cookie, 'cloudcli_hub_backend=lab');

    const api = await fetch(`${hub.url}/api/projects`, { headers: { Cookie: cookie! } });
    assert.deepEqual(await api.json(), { id: 'lab', path: '/api/projects', cookie: '' });
    const pinnedTab = await fetch(`${hub.url}/api/projects?hub_backend=office`, { headers: { Cookie: cookie! } });
    assert.equal((await pinnedTab.json() as { id: string }).id, 'office');
    const unknown = await fetch(`${hub.url}/api/projects?hub_backend=missing`, { headers: { Cookie: cookie! } });
    assert.equal(unknown.status, 400);
    const stream = await fetch(`${hub.url}/api/stream`, { headers: { Cookie: cookie! } });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    assert.match(await stream.text(), /lab-first[\s\S]*lab-second/);
    const upload = await fetch(`${hub.url}/api/upload?hub_backend=office`, {
      method: 'POST', headers: { Cookie: cookie! }, body: 'uploaded bytes',
    });
    assert.deepEqual(await upload.json(), { id: 'office', body: 'uploaded bytes' });

    const page = await fetch(`${hub.url}/cloudcli/`, { headers: { Cookie: cookie! } });
    const html = await page.text();
    assert.match(html, /__CLOUDCLI_BACKEND_ID__="lab"/);
    assert.match(html, /href="\/cloudcli\/favicon.svg"/);
    assert.match(html, /src="\/cloudcli\/assets\/main.js"/);
    assert.doesNotMatch(html, /cloudcli\/cloudcli/);
    assert.equal((await fetch(`${hub.url}/cloudcli/favicon.svg`)).status, 200);
    assert.deepEqual(await (await fetch(`${hub.url}/cloudcli/manifest.json`)).json(), {
      start_url: '/cloudcli/', scope: '/cloudcli/', icons: [{ src: '/cloudcli/icons/icon.png' }],
    });
    assert.match(await (await fetch(`${hub.url}/cloudcli/sw.js`)).text(), /cloudcli\/manifest\.json/);
    assert.equal((await fetch(`${hub.url}/logo.svg`)).status, 404);
    const deepLink = await fetch(`${hub.url}/session/abc?foo=1`, { redirect: 'manual' });
    assert.equal(deepLink.headers.get('location'), '/cloudcli/session/abc?foo=1');
  } finally {
    await hub.close();
  }
});

test('Hub rejects unconfigured selection and tunnels WebSocket traffic to the selected backend', async () => {
  const hub = await fixture();
  try {
    const rejected = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'unconfigured' }),
    });
    assert.equal(rejected.status, 400);
    const crossOrigin = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lab' }),
    });
    assert.equal(crossOrigin.status, 403);

    const socket = new WebSocket(hub.url.replace('http:', 'ws:') + '/ws?token=test&hub_backend=lab', {
      headers: { Cookie: 'cloudcli_hub_backend=office' },
    });
    try {
      await once(socket, 'open');
      socket.send('hello');
      const [message] = await once(socket, 'message');
      assert.equal(message.toString(), 'lab:hello');
    } finally {
      socket.close();
      await once(socket, 'close');
    }
  } finally {
    await hub.close();
  }
});

test('Hub configuration rejects arbitrary URL targets and duplicate backend IDs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-config-'));
  const configFile = path.join(directory, 'backends.json');
  const previous = process.env.HUB_BACKENDS_FILE;
  process.env.HUB_BACKENDS_FILE = configFile;
  try {
    await fs.writeFile(configFile, JSON.stringify({ backends: [{ id: 'office', name: 'Office', url: 'file:///etc/passwd' }] }));
    assert.throws(() => loadHubConfiguration(), /HTTP\(S\) origin/);
    await fs.writeFile(configFile, JSON.stringify({ backends: [
      { id: 'office', name: 'Office', url: 'http://127.0.0.1:3001' },
      { id: 'office', name: 'Duplicate', url: 'http://127.0.0.1:3002' },
    ] }));
    assert.throws(() => loadHubConfiguration(), /Duplicate backend id/);
  } finally {
    if (previous === undefined) delete process.env.HUB_BACKENDS_FILE;
    else process.env.HUB_BACKENDS_FILE = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
