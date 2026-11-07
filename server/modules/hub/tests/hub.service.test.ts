import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { createHubServer, loadHubConfiguration, startBackendRegistration } from '@/modules/hub/index.js';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return address.port;
}

async function fixture(registrationEnabled = false, seedRegisteredBackends: unknown[] = []) {
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
      if (request.url === '/api/auth/user') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ user: { isAdmin: request.headers.authorization === 'Bearer admin-token' } }));
        return;
      }
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
  const registryFile = path.join(directory, 'registered-backends.json');
  if (seedRegisteredBackends.length) {
    await fs.writeFile(registryFile, JSON.stringify({ backends: seedRegisteredBackends }));
  }
  const hub = createHubServer({
    backends: backends.map(({ id, port }) => ({ id, name: id, url: new URL(`http://127.0.0.1:${port}`) })),
    defaultBackendId: 'office',
    registryFile: registrationEnabled ? registryFile : undefined,
    authFile: path.join(directory, 'hub-auth.json'),
    distDirectory,
    publicDirectory,
    basePath: '/cloudcli',
  });
  const port = await listen(hub);
  return {
    url: `http://127.0.0.1:${port}`,
    registryFile,
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

test('an administrator provisions a backend key that maintains an online registration and routes traffic', async () => {
  const hub = await fixture(true);
  let forwardedAuthorization: string | undefined;
  let forwardedIdentity: string | undefined;
  const remote = http.createServer((_request, response) => {
    forwardedAuthorization = _request.headers.authorization;
    forwardedIdentity = _request.headers['x-cloudcli-hub-identity'] as string | undefined;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'remote' }));
  });
  const remotePort = await listen(remote);
  const envNames = [
    'CLOUDCLI_HUB_URL', 'CLOUDCLI_HUB_REGISTRATION_KEY', 'CLOUDCLI_BACKEND_ID',
    'CLOUDCLI_BACKEND_NAME', 'CLOUDCLI_BACKEND_URL',
  ];
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    const registerResponse = await fetch(`${hub.url}/hub/auth/register`, {
      method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
    });
    assert.equal(registerResponse.status, 201);
    const adminSession = await registerResponse.json() as { token: string };
    const originHeaders = { Origin: hub.url, 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession.token}` };
    const preferenceSave = await fetch(hub.url + '/hub/auth/preferences', {
      method: 'PATCH', headers: { Origin: hub.url, 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession.token}`, Cookie: 'cloudcli_hub_backend=lab' },
      body: JSON.stringify({ projectSortOrder: 'date' }),
    });
    assert.equal(preferenceSave.status, 200);
    const globalPreferences = await fetch(hub.url + '/api/user/preferences?hub_backend=office', {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal((await globalPreferences.json() as { preferences: { projectSortOrder: string } }).preferences.projectSortOrder, 'date');

    const createUserResponse = await fetch(`${hub.url}/hub/auth/users`, {
      method: 'POST', headers: originHeaders, body: JSON.stringify({ username: 'member', password: 'member-pass-123' }),
    });
    assert.equal(createUserResponse.status, 201);
    const memberLogin = await fetch(`${hub.url}/hub/auth/login`, {
      method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-pass-123' }),
    });
    const memberSession = await memberLogin.json() as { token: string };
    const deniedAdmin = await fetch(`${hub.url}/hub/admin/backends`, { headers: { Authorization: `Bearer ${memberSession.token}` } });
    assert.equal(deniedAdmin.status, 403);
    const provisioned = await fetch(`${hub.url}/hub/admin/backends`, {
      method: 'POST', headers: originHeaders, body: JSON.stringify({ name: 'Remote Codex' }),
    });
    assert.equal(provisioned.status, 201);
    const provisionedBackend = await provisioned.json() as { backend: { id: string; name: string }; key: string };
    assert.equal(provisionedBackend.backend.name, 'Remote Codex');

    const existingKeyResponse = await fetch(`${hub.url}/hub/admin/backends/office/key`, {
      method: 'POST', headers: originHeaders,
    });
    assert.equal(existingKeyResponse.status, 200);
    const existingKey = await existingKeyResponse.json() as { key: string };
    assert.ok(existingKey.key);
    const labKeyResponse = await fetch(`${hub.url}/hub/admin/backends/lab/key`, {
      method: 'POST', headers: originHeaders,
    });
    const labKey = await labKeyResponse.json() as { key: string };
    assert.equal(labKeyResponse.status, 200);
    assert.notEqual(existingKey.key, labKey.key, 'each backend must receive its own unique registration key');

    // A same-origin browser GET may omit Origin; the Hub account still grants access.
    const adminListResponse = await fetch(`${hub.url}/hub/admin/backends`, {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(adminListResponse.status, 200);

    const adminList = await adminListResponse.json() as { backends: Array<{ id: string; keyConfigured: boolean }> };
    assert.equal(adminList.backends.find(({ id }) => id === 'office')?.keyConfigured, true);
    assert.equal(adminList.backends.find(({ id }) => id === provisionedBackend.backend.id)?.keyConfigured, true);
    const unauthenticatedRoute = await fetch(`${hub.url}/api/projects?hub_backend=office`);
    assert.equal(unauthenticatedRoute.status, 401);

    const deniedSocket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/hub/register/ws?backend_id=${provisionedBackend.backend.id}`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const deniedStatus = await new Promise<number>((resolve) => {
      deniedSocket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      deniedSocket.once('error', () => undefined);
    });
    assert.equal(deniedStatus, 401);
    deniedSocket.terminate();

    process.env.CLOUDCLI_HUB_URL = hub.url;
    process.env.CLOUDCLI_HUB_REGISTRATION_KEY = provisionedBackend.key;
    process.env.CLOUDCLI_BACKEND_ID = provisionedBackend.backend.id;
    process.env.CLOUDCLI_BACKEND_NAME = provisionedBackend.backend.name;
    process.env.CLOUDCLI_BACKEND_URL = `http://127.0.0.1:${remotePort}`;
    const stopRegistration = startBackendRegistration();
    try {
      let listed = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${hub.url}/hub/backends`);
        const payload = await response.json() as { backends: Array<{ id: string; name: string; online: boolean }> };
        listed = payload.backends.some(({ id, name, online }) => id === provisionedBackend.backend.id && name === 'Remote Codex' && online);
        if (listed) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(listed, true, 'backend registration heartbeat should add the backend to Hub');
      const connectedList = await (await fetch(`${hub.url}/hub/backends`)).json() as { backends: Array<{ id: string; online: boolean }> };
      assert.equal(connectedList.backends.find(({ id }) => id === provisionedBackend.backend.id)?.online, true, JSON.stringify(connectedList));
      const routed = await fetch(`${hub.url}/api/projects?hub_backend=${provisionedBackend.backend.id}`, {
        headers: { Authorization: `Bearer ${adminSession.token}` },
      });
      assert.deepEqual(await routed.json(), { id: 'remote' });
      assert.equal(forwardedAuthorization, undefined, 'the browser Hub token must not be forwarded to a backend');
      assert.ok(forwardedIdentity, 'Hub should forward a backend-scoped signed identity assertion');
      const registry = JSON.parse(await fs.readFile(hub.registryFile, 'utf8')) as { backends: Array<{ id: string }> };
      assert.equal(registry.backends.some(({ id }) => id === provisionedBackend.backend.id), true);
      stopRegistration();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const disconnectedList = await (await fetch(`${hub.url}/hub/backends`)).json() as { backends: Array<{ id: string; online: boolean }> };
      assert.equal(disconnectedList.backends.find(({ id }) => id === provisionedBackend.backend.id)?.online, false);
      const offlineRoute = await fetch(`${hub.url}/api/projects?hub_backend=${provisionedBackend.backend.id}`);
      assert.equal(offlineRoute.status, 503);
      const backendPage = await (await fetch(`${hub.url}/hub/`)).text();
      assert.match(backendPage, /Remote Codex/);
      assert.match(backendPage, /data-online="false"/);
      assert.match(backendPage, /离线/);
    } finally {
      stopRegistration();
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await hub.close();
  }
});

test('Hub retains a registered backend as offline after restart without its connection', async () => {
  const hub = await fixture(true, [{
    id: 'persistent', name: 'Persistent backend', url: 'http://127.0.0.1:3009', keyHash: 'a'.repeat(64),
    registeredAt: Date.now() - 181_000, lastConnectedAt: Date.now() - 181_000,
  }]);
  try {
    const response = await fetch(`${hub.url}/hub/backends`);
    const payload = await response.json() as { backends: Array<{ id: string; online: boolean }> };
    assert.deepEqual(payload.backends.map(({ id }) => id), ['office', 'lab', 'persistent']);
    assert.equal(payload.backends.find(({ id }) => id === 'persistent')?.online, false);
  } finally {
    await hub.close();
  }
});

test('Hub selects a fixed backend and keeps API, streams, and static frontend on one origin', async () => {
  const hub = await fixture();
  try {
    const defaultResponse = await fetch(`${hub.url}/api/projects`);
    assert.equal(defaultResponse.status, 400, 'backend APIs require explicit ownership');

    const selected = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lab' }),
    });
    assert.equal(selected.status, 410);
    const cookie = 'cloudcli_hub_backend=lab';
    assert.equal(selected.headers.get('set-cookie'), null);

    const api = await fetch(`${hub.url}/api/projects`, { headers: { Cookie: cookie! } });
    assert.equal(api.status, 400);
    const pinnedTab = await fetch(`${hub.url}/api/projects?hub_backend=office`, { headers: { Cookie: cookie! } });
    assert.equal(pinnedTab.status, 401);
    const unknown = await fetch(`${hub.url}/api/projects?hub_backend=missing`, { headers: { Cookie: cookie! } });
    assert.equal(unknown.status, 400);
    const stream = await fetch(`${hub.url}/api/stream`, { headers: { Cookie: cookie! } });
    assert.equal(stream.status, 401);
    const upload = await fetch(`${hub.url}/api/upload?hub_backend=office`, {
      method: 'POST', headers: { Cookie: cookie! }, body: 'uploaded bytes',
    });
    assert.equal(upload.status, 401);

    const page = await fetch(`${hub.url}/cloudcli/`, { headers: { Cookie: cookie! } });
    const html = await page.text();
    assert.match(html, /__CLOUDCLI_HUB__=true/);
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

test('Hub rejects unconfigured selection and requires Hub login before opening WebSocket traffic', async () => {
  const hub = await fixture();
  try {
    const rejected = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'unconfigured' }),
    });
    assert.equal(rejected.status, 410);
    const crossOrigin = await fetch(`${hub.url}/hub/select`, {
      method: 'POST',
      headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lab' }),
    });
    assert.equal(crossOrigin.status, 410);

    const socket = new WebSocket(hub.url.replace('http:', 'ws:') + '/ws?token=test&hub_backend=lab', {
      headers: { Cookie: 'cloudcli_hub_backend=office' },
    });
    const deniedStatus = await new Promise<number>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once('error', () => undefined);
    });
    assert.equal(deniedStatus, 401);
    socket.terminate();
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

test('backend display settings persist and a renamed backend reconnects with its original name and key', async () => {
  const hub = await fixture(true);
  let socket: WebSocket | undefined;
  try {
    const account = await fetch(`${hub.url}/hub/auth/register`, {
      method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
    });
    assert.equal(account.status, 201);
    const { token } = await account.json() as { token: string };
    const headers = { Origin: hub.url, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const keyResponse = await fetch(`${hub.url}/hub/admin/backends/office/key`, { method: 'POST', headers });
    const { key } = await keyResponse.json() as { key: string };
    const before = JSON.parse(await fs.readFile(hub.registryFile, 'utf8'));
    const update = await fetch(`${hub.url}/hub/admin/backends/office`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'My Office', color: '#AB12CD' }),
    });
    assert.equal(update.status, 200);
    const saved = JSON.parse(await fs.readFile(hub.registryFile, 'utf8'));
    assert.equal(saved.backends[0].keyHash, before.backends[0].keyHash);
    assert.equal(saved.backends[0].color, '#ab12cd');
    assert.equal(saved.backends[0].name, 'My Office');
    const invalid = await fetch(`${hub.url}/hub/admin/backends/office`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: 'Bad', color: 'url(invalid)' }),
    });
    assert.equal(invalid.status, 400);
    socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/hub/register/ws?backend_id=office`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    await once(socket, 'open');
    const acknowledged = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'office', name: 'office', url: 'http://127.0.0.1:12345' }));
    assert.equal(JSON.parse(String((await acknowledged)[0])).kind, 'registered');
    const inventory = await (await fetch(`${hub.url}/hub/backends`)).json() as { backends: Array<{ id: string; name: string; color: string; online: boolean; lastConnectedAt: number }> };
    assert.deepEqual(inventory.backends.find((backend) => backend.id === 'office'), {
      id: 'office', name: 'My Office', color: '#ab12cd', online: true,
      registeredAt: saved.backends[0].registeredAt,
      lastConnectedAt: inventory.backends.find((backend) => backend.id === 'office')!.lastConnectedAt,
    });
    const afterReconnect = JSON.parse(await fs.readFile(hub.registryFile, 'utf8'));
    const reloaded = await fixture(true, afterReconnect.backends);
    try {
      const list = await (await fetch(`${reloaded.url}/hub/backends`)).json() as typeof inventory;
      assert.equal(list.backends.find((backend) => backend.id === 'office')?.name, 'My Office');
      assert.equal(list.backends.find((backend) => backend.id === 'office')?.color, '#ab12cd');
    } finally { await reloaded.close(); }
  } finally { socket?.terminate(); await hub.close(); }
});
