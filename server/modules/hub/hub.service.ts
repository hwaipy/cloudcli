import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

import mime from 'mime-types';
import { WebSocket, WebSocketServer } from 'ws';

import { createHubIdentityAssertion } from '@/shared/hub-identity.js';

import { createHubAuthService, HubAuthError, type HubUserIdentity } from './hub-auth.service.js';

type HubBackend = { id: string; name: string; color?: string; url: URL | null; registeredAt?: number; lastConnectedAt?: number | null; online?: boolean; keyConfigured?: boolean };
type RoutableHubBackend = HubBackend & { url: URL };
type HubConfiguration = {
  backends: HubBackend[];
  defaultBackendId: string;
  registryFile?: string;
  authFile: string;
  distDirectory: string;
  publicDirectory: string;
  basePath: string;
};

type HubConfigFile = {
  backends?: Array<{ id?: unknown; name?: unknown; url?: unknown }>;
  defaultBackendId?: unknown;
};

type RegisteredBackend = HubBackend & { registeredAt: number; lastConnectedAt: number | null; keyHash: string | null };

// Stable defaults keep existing backends visually distinct before an administrator selects a color.
function backendColor(backend: Pick<HubBackend, 'id' | 'color'>): string {
  if (backend.color && /^#[0-9a-fA-F]{6}$/.test(backend.color)) return backend.color.toLowerCase();
  const palette = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#06b6d4'];
  return palette[createHash('sha256').update(backend.id).digest()[0] % palette.length];
}

const COOKIE_NAME = 'cloudcli_hub_backend';
const PROXIED_HTTP_PATHS = ['/api/', '/health'];
const PROXIED_SOCKET_PATHS = ['/ws', '/shell', '/plugin-ws/', '/desktop-notifications'];
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function normalizeBasePath(value: string): string {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(value)) throw new Error('HUB_BASE_PATH must be a simple absolute path');
  return value.replace(/\/+$/, '');
}

function parseBackends(raw: HubConfigFile): { backends: HubBackend[]; defaultBackendId: string } {
  if (!Array.isArray(raw.backends) || raw.backends.length === 0) {
    throw new Error('Hub configuration must contain at least one backend');
  }
  const seen = new Set<string>();
  const backends = raw.backends.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || typeof item.url !== 'string') {
      throw new Error('Each backend needs a valid id, name, and URL');
    }
    if (seen.has(item.id)) throw new Error(`Duplicate backend id: ${item.id}`);
    seen.add(item.id);
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`Backend ${item.id} must use an HTTP(S) origin without credentials or a path`);
    }
    return { id: item.id, name: item.name, url };
  });
  const defaultBackendId = typeof raw.defaultBackendId === 'string' ? raw.defaultBackendId : backends[0].id;
  if (!seen.has(defaultBackendId)) throw new Error('defaultBackendId does not name a configured backend');
  return { backends, defaultBackendId };
}

function selectedBackend(request: IncomingMessage, config: HubConfiguration, backends: HubBackend[]): HubBackend | null {
  const url = new URL(request.url ?? '/', 'http://hub.local');
  const explicitId = request.headers['x-cloudcli-backend'] ?? url.searchParams.get('hub_backend');
  if (explicitId !== undefined && explicitId !== null) {
    return typeof explicitId === 'string'
      ? backends.find((backend) => backend.id === explicitId) ?? null
      : null;
  }
  // A stale browser selection must never change an unqualified request.
  return backends.find((backend) => backend.id === config.defaultBackendId) ?? null;
}

function readRegisteredBackends(registryFile: string | undefined): RegisteredBackend[] {
  if (!registryFile) return [];
  let parsed: { backends?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as { backends?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Could not read Hub backend registry: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed.backends)) throw new Error('Hub backend registry has an invalid format');
  const valid: RegisteredBackend[] = [];
  for (const item of parsed.backends) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.registeredAt !== 'number') continue;
    try {
      const backend = candidate.url === null || candidate.url === undefined
        ? parseBackends({ backends: [{ id: candidate.id, name: candidate.name, url: 'http://127.0.0.1' }] }).backends[0]
        : parseBackends({ backends: [{ id: candidate.id, name: candidate.name, url: candidate.url }] }).backends[0];
      const keyHash = typeof candidate.keyHash === 'string' && /^[a-f0-9]{64}$/.test(candidate.keyHash)
        ? candidate.keyHash
        : null;
      valid.push({
        ...backend,
        color: typeof candidate.color === 'string' ? backendColor({ id: backend.id, color: candidate.color }) : undefined,
        url: candidate.url === null || candidate.url === undefined ? null : backend.url,
        registeredAt: candidate.registeredAt,
        lastConnectedAt: typeof candidate.lastConnectedAt === 'number' ? candidate.lastConnectedAt : null,
        keyHash,
        online: false,
      });
    } catch { /* Ignore malformed registry entries; registration will replace them. */ }
  }
  return valid;
}

function saveRegisteredBackends(registryFile: string | undefined, backends: RegisteredBackend[]): void {
  if (!registryFile) throw new Error('Hub backend registry is not configured');
  const directory = path.dirname(registryFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${registryFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ backends }, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, registryFile);
  try { fs.chmodSync(registryFile, 0o600); } catch { /* The registry remains protected by its parent directory. */ }
}

function registrationKeyMatches(request: IncomingMessage, expectedHash: string | null | undefined): boolean {
  if (!expectedHash) return false;
  const authorization = request.headers.authorization;
  const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const actualBytes = Buffer.from(provided);
  if (!provided) return false;
  const actualHash = createHash('sha256').update(actualBytes).digest();
  const expectedBytes = Buffer.from(expectedHash, 'hex');
  return actualHash.length === expectedBytes.length && timingSafeEqual(actualHash, expectedBytes);
}

function selectedBackendOrError(request: IncomingMessage, response: ServerResponse, config: HubConfiguration, backends: HubBackend[]): RoutableHubBackend | null {
  const backend = selectedBackend(request, config, backends);
  if (!backend) sendJson(response, 400, { error: 'Unknown backend' });
  else if (!backend.online || !backend.url) {
    sendJson(response, 503, { error: 'Selected backend is offline', backendId: backend.id });
    return null;
  }
  return backend as RoutableHubBackend | null;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readJsonRequestBody(request: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > maxBytes) throw new Error('Request body too large');
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
  return parsed as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
}

function handleHubAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  auth: ReturnType<typeof createHubAuthService>,
): void {
  const mutation = request.method !== 'GET';
  if (mutation && !isSameOrigin(request)) { sendJson(response, 403, { error: 'Same-origin request required' }); return; }
  const identity = auth.authenticate(bearerToken(request));
  const execute = async () => {
    try {
      if (pathname === '/hub/auth/status' && request.method === 'GET') {
        sendJson(response, 200, auth.getStatus());
        return;
      }
      if (pathname === '/hub/auth/register' && request.method === 'POST') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 201, auth.register(body.username, body.password));
        return;
      }
      if (pathname === '/hub/auth/login' && request.method === 'POST') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 200, auth.login(body.username, body.password));
        return;
      }
      if (!identity) { response.setHeader('X-Auth-Error', 'invalid-token'); sendJson(response, 401, { error: 'Hub login required', code: 'HUB_AUTH_REQUIRED' }); return; }
      if (pathname === '/hub/auth/preferences' && request.method === 'GET') {
        sendJson(response, 200, auth.getPreferences(identity)); return;
      }
      if (pathname === '/hub/auth/preferences' && request.method === 'PATCH') {
        sendJson(response, 200, auth.savePreferences(identity, await readJsonRequestBody(request, 262144))); return;
      }
      if (pathname === '/hub/auth/user' && request.method === 'GET') {
        sendJson(response, 200, auth.getUser(identity));
        return;
      }
      if (pathname === '/hub/auth/refresh' && request.method === 'POST') {
        sendJson(response, 200, auth.refresh(identity));
        return;
      }
      if (pathname === '/hub/auth/logout' && request.method === 'POST') {
        sendJson(response, 200, { success: true });
        return;
      }
      if (pathname === '/hub/auth/user' && request.method === 'PATCH') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 200, auth.updateOwnAccount(identity, body.username, body.currentPassword, body.newPassword));
        return;
      }
      if (pathname === '/hub/auth/user/avatar' && request.method === 'PATCH') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 200, auth.updateAvatar(identity, body.avatar));
        return;
      }
      if (pathname === '/hub/auth/users' && request.method === 'GET') {
        sendJson(response, 200, auth.listUsers(identity));
        return;
      }
      if (pathname === '/hub/auth/users' && request.method === 'POST') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 201, auth.createUser(identity, body.username, body.password));
        return;
      }
      const userIdMatch = pathname.match(/^\/hub\/auth\/users\/([a-f0-9]{32})$/);
      if (userIdMatch && request.method === 'PATCH') {
        const body = await readJsonRequestBody(request);
        sendJson(response, 200, auth.updateUser(identity, userIdMatch[1], body.username, body.newPassword));
        return;
      }
      sendJson(response, 404, { error: 'Hub authentication endpoint not found' });
    } catch (error) {
      if (error instanceof HubAuthError) {
        sendJson(response, error.status, { error: error.message, code: error.code });
        return;
      }
      const tooLarge = (error as Error).message === 'Request body too large';
      sendJson(response, tooLarge ? 413 : 400, { error: (error as Error).message });
    }
  };
  void execute();
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin || typeof origin !== 'string') return false;
  try {
    const expectedProtocol = request.headers['x-forwarded-proto'] ?? (request.socket instanceof TLSSocket ? 'https' : 'http');
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && parsed.protocol === `${expectedProtocol}:`;
  } catch {
    return false;
  }
}

function proxyHeaders(request: IncomingMessage, backend: RoutableHubBackend, identityAssertion?: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: backend.url.host };
  delete headers.authorization;
  delete headers['x-cloudcli-hub-identity'];
  if (identityAssertion) headers['x-cloudcli-hub-identity'] = identityAssertion;
  // Hub's selection cookie is transport metadata; the application backend has
  // no reason to see it. Keep any backend-owned cookies intact.
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${COOKIE_NAME}=`));
  if (cookies.length) headers.cookie = cookies.join('; ');
  else delete headers.cookie;
  headers['x-forwarded-host'] = request.headers.host;
  headers['x-forwarded-proto'] = request.headers['x-forwarded-proto'] ?? (request.socket instanceof TLSSocket ? 'https' : 'http');
  headers['x-forwarded-for'] = [request.headers['x-forwarded-for'], request.socket.remoteAddress]
    .filter(Boolean).join(', ');
  return headers;
}

function proxyHttp(request: IncomingMessage, response: ServerResponse, backend: RoutableHubBackend, identityAssertion?: string): void {
  const transport = backend.url.protocol === 'https:' ? https : http;
  const upstream = transport.request(backend.url, {
    method: request.method,
    path: request.url,
    headers: proxyHeaders(request, backend, identityAssertion),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) sendJson(response, 502, { error: 'Selected backend is unavailable' });
    else response.destroy();
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

function writeSocketError(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function proxySocket(request: IncomingMessage, socket: Duplex, head: Buffer, backend: RoutableHubBackend, identityAssertion: string): void {
  const transport = backend.url.protocol === 'https:' ? https : http;
  const forwardedUrl = new URL(request.url ?? '/', 'http://hub.local');
  forwardedUrl.searchParams.delete('token');
  const upstream = transport.request(backend.url, {
    method: request.method,
    path: `${forwardedUrl.pathname}${forwardedUrl.search}`,
    headers: proxyHeaders(request, backend, identityAssertion),
  });
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n`);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined) socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
    }
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
  });
  upstream.on('response', (upstreamResponse) => {
    writeSocketError(socket, upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage ?? 'Bad Gateway');
    upstreamResponse.resume();
  });
  upstream.on('error', () => writeSocketError(socket, 502, 'Bad Gateway'));
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

function staticFilePath(relativePath: string, config: HubConfiguration): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(relativePath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  const sanitized = decoded.replace(/^\/+/, '');
  for (const directory of [config.distDirectory, config.publicDirectory]) {
    const candidate = path.resolve(directory, sanitized);
    if (!candidate.startsWith(`${path.resolve(directory)}${path.sep}`)) continue;
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Try the next directory. */ }
  }
  return null;
}

function serveStatic(request: IncomingMessage, response: ServerResponse, config: HubConfiguration, pathname: string, backends: HubBackend[]): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const relativePath = pathname.slice(config.basePath.length).replace(/^\/+/, '');
  const file = relativePath ? staticFilePath(relativePath, config) : null;
  const isNavigation = relativePath === '' || relativePath === 'index.html'
    || (!file && !path.posix.extname(relativePath));
  const selectedFile = file ?? (isNavigation ? path.join(config.distDirectory, 'index.html') : null);
  if (!selectedFile) { response.writeHead(404).end(); return; }
  if (isNavigation) {
    fs.promises.readFile(selectedFile, 'utf8').then((html) => {
      const backendId = selectedBackend(request, config, backends)?.id ?? config.defaultBackendId;
      const runtimeConfig = `<script>window.__ROUTER_BASENAME__=${JSON.stringify(config.basePath)};window.__CLOUDCLI_HUB__=true;</script>`;
      const prefixed = html
        .replace(/\b(href|src)="\/([^"]*)"/g, (match, attribute: string, target: string) =>
          target.startsWith(`${config.basePath.slice(1)}/`) ? match : `${attribute}="${config.basePath}/${target}"`)
        .replaceAll("register('/sw.js')", `register('${config.basePath}/sw.js')`)
        .replace('</head>', `${runtimeConfig}</head>`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : prefixed);
    }).catch(() => sendJson(response, 503, { error: 'Frontend build is missing' }));
    return;
  }
  const contentType = mime.lookup(selectedFile) || 'application/octet-stream';
  if (relativePath === 'manifest.json' || relativePath === 'sw.js') {
    fs.promises.readFile(selectedFile, 'utf8').then((content) => {
      const prefixed = relativePath === 'manifest.json'
        ? content.replaceAll('"/"', `"${config.basePath}/"`).replaceAll('"/icons/', `"${config.basePath}/icons/`)
        : content.replaceAll("'/manifest.json'", `'${config.basePath}/manifest.json'`)
          .replaceAll("'/logo-", `'${config.basePath}/logo-`)
          .replaceAll('`/session/${sessionId}`', `\`${config.basePath}/session/\${sessionId}\``)
          .replaceAll(" : '/'", ` : '${config.basePath}/'`);
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : prefixed);
    }).catch(() => response.writeHead(404).end());
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': /-[a-zA-Z0-9_-]{8,}\./.test(path.basename(selectedFile)) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(selectedFile).pipe(response);
}

function selectionPage(config: HubConfiguration, _selectedId: string): string {
  const names = config.backends.map(({ name, online }) => `<li data-online="${Boolean(online)}">${name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')} · ${online ? '在线' : '离线'}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CloudCLI Hub</title><h1>CloudCLI 后端</h1><p>所有项目在同一个工作区管理，按项目归属访问后端。</p><ul>${names}</ul><a href="${config.basePath}/">返回工作区</a></html>`;
}

/** Used by the standalone Hub entry point and tests to route one selected backend's HTTP and WebSocket traffic. */
export function createHubServer(config: HubConfiguration): http.Server {
  const registeredBackends = new Map(readRegisteredBackends(config.registryFile).map((backend) => [backend.id, backend]));
  const registrationKeys = new Map<string, string>();
  const connections = new Map<string, WebSocket>();
  const authService = createHubAuthService(config.authFile);
  const registrationServer = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const socketLiveness = new Map<WebSocket, boolean>();
  const listBackends = (): HubBackend[] => {
    const available = new Map(config.backends.map((backend) => [backend.id, {
      ...backend,
      color: backendColor(backend),
      // Keep statically configured backends routable until they have completed
      // their first managed registration. This lets an admin open Settings and
      // provision the key needed to move that backend to the persistent link.
      online: !config.registryFile || !registeredBackends.get(backend.id)?.lastConnectedAt || connections.has(backend.id),
      keyConfigured: Boolean(registeredBackends.get(backend.id)?.keyHash),
    }]));
    for (const [id, backend] of registeredBackends) {
      const staticBackend = config.backends.find((candidate) => candidate.id === id);
      const url = backend.url ?? staticBackend?.url ?? null;
      available.set(id, { id, name: backend.name, color: backendColor(backend), url, registeredAt: backend.registeredAt,
        lastConnectedAt: backend.lastConnectedAt,
        online: connections.has(id) || (!backend.lastConnectedAt && Boolean(staticBackend?.url)),
        keyConfigured: Boolean(backend.keyHash) });
    }
    return [...available.values()];
  };

  registrationServer.on('connection', (socket, request) => {
    socketLiveness.set(socket, true);
    socket.on('pong', () => socketLiveness.set(socket, true));
    const registrationUrl = new URL(request.url ?? '/', 'http://hub.local');
    const backendId = registrationUrl.searchParams.get('backend_id');
    const registrationTimeout = setTimeout(() => socket.close(1008, 'Registration payload required'), 5000);
    socket.once('message', (raw, isBinary) => {
      clearTimeout(registrationTimeout);
      if (isBinary) { socket.close(1008, 'Registration payload must be text JSON'); return; }
      let payload: { id?: unknown; name?: unknown; url?: unknown };
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
        payload = parsed as typeof payload;
      } catch { socket.close(1008, 'Invalid registration payload'); return; }
      if (typeof payload.id !== 'string' || payload.id !== backendId || typeof payload.url !== 'string') {
        socket.close(1008, 'Registration needs id, name, and url');
        return;
      }
      const existing = backendId ? registeredBackends.get(backendId) : undefined;
      // Display names belong to Hub settings; old backend environment names remain valid after a rename.
      if (!existing?.keyHash || typeof payload.name !== 'string') {
        socket.close(1008, 'Backend identity does not match its Hub registration');
        return;
      }
      let backendUrl: URL;
      try {
        backendUrl = parseBackends({ backends: [{ id: payload.id, name: payload.name, url: payload.url }] }).backends[0].url!;
      } catch { socket.close(1008, 'Invalid backend identity or URL'); return; }

      const record: RegisteredBackend = {
        ...existing,
        url: backendUrl,
        lastConnectedAt: Date.now(),
        keyHash: existing.keyHash,
        online: true,
      };
      registeredBackends.set(backendId!, record);
      try {
        saveRegisteredBackends(config.registryFile, [...registeredBackends.values()]);
      } catch (error) {
        registeredBackends.set(backendId!, existing);
        socket.close(1011, 'Could not persist backend registration');
        console.error(`[Hub] Could not persist registration for ${backendId}: ${(error as Error).message}`);
        return;
      }
      const previous = connections.get(backendId!);
      if (previous && previous !== socket) previous.close(1012, 'Replaced by a newer backend connection');
      const credential = bearerToken(request);
      if (!credential) { socket.close(1008, 'Backend registration key missing'); return; }
      connections.set(backendId!, socket);
      registrationKeys.set(backendId!, credential);
      socket.send(JSON.stringify({ kind: 'registered', id: backendId, online: true }));
      console.info(`[Hub] Backend ${backendId} connected`);
    });
    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      socketLiveness.delete(socket);
      const record = [...connections.entries()].find(([, current]) => current === socket);
      if (record) {
        connections.delete(record[0]);
        registrationKeys.delete(record[0]);
      }
    });
    socket.on('error', () => undefined);
  });

  const heartbeat = setInterval(() => {
    for (const socket of registrationServer.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socketLiveness.get(socket) === false) { socket.terminate(); continue; }
      socketLiveness.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const mintBackendKey = (backendId: string, backendName?: string) => {
    const configured = config.backends.find(({ id }) => id === backendId);
    const previous = registeredBackends.get(backendId);
    const name = backendName ?? previous?.name ?? configured?.name;
    if (!name) throw new Error('Backend not found');
    const key = randomBytes(32).toString('base64url');
    const record: RegisteredBackend = {
      id: backendId,
      name,
      color: previous?.color,
      url: previous?.url ?? configured?.url ?? null,
      registeredAt: previous?.registeredAt ?? Date.now(),
      lastConnectedAt: previous?.lastConnectedAt ?? null,
      keyHash: createHash('sha256').update(key).digest('hex'),
    };
    registeredBackends.set(backendId, record);
    try {
      saveRegisteredBackends(config.registryFile, [...registeredBackends.values()]);
    } catch (error) {
      if (previous) registeredBackends.set(backendId, previous);
      else registeredBackends.delete(backendId);
      throw error;
    }
    const currentConnection = connections.get(backendId);
    if (currentConnection) {
      connections.delete(backendId);
      registrationKeys.delete(backendId);
      currentConnection.close(4001, 'Backend key rotated; reconnect with the new key');
    }
    return { key, backend: { id: backendId, name, online: false, keyConfigured: true, registeredAt: record.registeredAt } };
  };

  const handleHubAdminRequest = async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    if (request.method !== 'GET' && !isSameOrigin(request)) { sendJson(response, 403, { error: 'Same-origin request required' }); return; }
    if (!config.registryFile) { sendJson(response, 503, { error: 'Hub backend registry is not configured' }); return; }
    const identity = authService.authenticate(bearerToken(request));
    if (!identity) {
      sendJson(response, 401, { error: 'Hub login required', code: 'HUB_AUTH_REQUIRED' });
      return;
    }
    if (!identity.isAdmin) {
      sendJson(response, 403, { error: 'Administrator access required', code: 'HUB_AUTH_ADMIN_REQUIRED' });
      return;
    }

    if (pathname === '/hub/admin/backends' && request.method === 'GET') {
      sendJson(response, 200, {
        backends: listBackends().map(({ id, name, color, online, keyConfigured, registeredAt, lastConnectedAt }) => ({
          id, name, color, online, keyConfigured: Boolean(keyConfigured), registeredAt: registeredAt ?? null, lastConnectedAt: lastConnectedAt ?? null,
        })),
      });
      return;
    }

    const metadataMatch = pathname.match(/^\/hub\/admin\/backends\/([a-zA-Z0-9_-]{1,48})$/);
    if (metadataMatch && request.method === 'PATCH') {
      let body: Record<string, unknown>;
      try { body = await readJsonRequestBody(request); } catch {
        sendJson(response, 400, { error: 'Invalid JSON request' }); return;
      }
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100
        || typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
        sendJson(response, 400, { error: 'Provide a name (1-100 characters) and a hexadecimal color (#RRGGBB)' }); return;
      }
      const id = metadataMatch[1];
      const previous = registeredBackends.get(id);
      const configured = config.backends.find((backend) => backend.id === id);
      if (!previous && !configured) { sendJson(response, 404, { error: 'Backend not found' }); return; }
      const record: RegisteredBackend = {
        ...(previous ?? configured!), id, name: body.name.trim(), color: body.color.toLowerCase(),
        registeredAt: previous?.registeredAt ?? Date.now(),
        lastConnectedAt: previous?.lastConnectedAt ?? null, keyHash: previous?.keyHash ?? null,
      };
      registeredBackends.set(id, record);
      try { saveRegisteredBackends(config.registryFile, [...registeredBackends.values()]); } catch {
        if (previous) registeredBackends.set(id, previous); else registeredBackends.delete(id);
        sendJson(response, 500, { error: 'Could not save backend settings' }); return;
      }
      sendJson(response, 200, { backend: { id, name: record.name, color: record.color } });
      return;
    }

    const existingKeyMatch = pathname.match(/^\/hub\/admin\/backends\/([a-zA-Z0-9_-]{1,48})\/key$/);
    if (existingKeyMatch && request.method === 'POST') {
      try {
        const minted = mintBackendKey(existingKeyMatch[1]);
        sendJson(response, 200, minted);
      } catch (error) {
        sendJson(response, 404, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/hub/admin/backends' && request.method === 'POST') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
        sendJson(response, 415, { error: 'application/json is required' });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonRequestBody(request); } catch (error) {
        const tooLarge = (error as Error).message === 'Request body too large';
        sendJson(response, tooLarge ? 413 : 400, { error: (error as Error).message });
        return;
      }
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
        sendJson(response, 400, { error: 'Backend name must contain 1-100 characters' });
        return;
      }
      let id: string;
      do { id = `backend-${randomBytes(6).toString('hex')}`; }
      while (listBackends().some((backend) => backend.id === id));
      try {
        const minted = mintBackendKey(id, body.name.trim());
        sendJson(response, 201, minted);
      } catch (error) {
        sendJson(response, 500, { error: `Could not save backend: ${(error as Error).message}` });
      }
      return;
    }

    sendJson(response, 404, { error: 'Hub admin endpoint not found' });
  };

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://hub.local').pathname;
    if (pathname === '/hub/health') { sendJson(response, 200, { status: 'ok' }); return; }
    if (pathname === '/api/user/preferences') {
      handleHubAuthRequest(request, response, '/hub/auth/preferences', authService); return;
    }
    if (pathname.startsWith('/hub/auth/')) {
      handleHubAuthRequest(request, response, pathname, authService);
      return;
    }
    if (pathname.startsWith('/api/auth/')) {
      const authPath = pathname.replace('/api/auth', '/hub/auth');
      handleHubAuthRequest(request, response, authPath, authService);
      return;
    }
    if (pathname === '/hub/admin/backends' || pathname.startsWith('/hub/admin/backends/')) {
      void handleHubAdminRequest(request, response, pathname).catch((error) => {
        console.error(`[Hub] Backend management request failed: ${(error as Error).message}`);
        if (!response.headersSent) sendJson(response, 500, { error: 'Hub backend management failed' });
        else response.destroy();
      });
      return;
    }
    if (pathname === '/hub/register') {
      response.setHeader('Upgrade', 'websocket');
      sendJson(response, 426, { error: 'Use the persistent /hub/register/ws WebSocket connection' });
      return;
    }
    if (pathname === '/hub/backends') {
      const backends = listBackends();
      sendJson(response, 200, {
        defaultBackendId: config.defaultBackendId,
        selectedBackendId: config.defaultBackendId,
        backends: backends.map(({ id, name, color, online, registeredAt, lastConnectedAt }) => ({ id, name, color, online, registeredAt, lastConnectedAt })),
      });
      return;
    }
    if (pathname === '/hub' || pathname === '/hub/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      const backends = listBackends();
      response.end(selectionPage({ ...config, backends }, selectedBackend(request, config, backends)?.id ?? config.defaultBackendId));
      return;
    }
    if (pathname === '/hub/select') {
      sendJson(response, 410, { error: 'Select a project instead of switching the workspace backend', code: 'HUB_WORKSPACE_SWITCH_REMOVED' }); return;
    }
    if (PROXIED_HTTP_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
      if (/^\/api\/(projects(?:\/|$)|providers\/(?:[^/]+\/)?sessions(?:\/|$)|file-tree\/projects\/|assets\/|user\/drafts|git\/|taskmaster\/)/.test(pathname) && !request.headers['x-cloudcli-backend'] && !new URL(request.url!, 'http://hub.local').searchParams.has('hub_backend')) {
        sendJson(response, 400, { error: 'This backend operation requires an explicit backend', code: 'HUB_BACKEND_REQUIRED' }); return;
      }
      const backend = selectedBackendOrError(request, response, config, listBackends());
      if (!backend) return;
      if (pathname === '/health') {
        proxyHttp(request, response, backend);
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://hub.local');
      const token = bearerToken(request) ?? requestUrl.searchParams.get('token');
      const identity = authService.authenticate(token);
      if (!identity) { response.setHeader('X-Auth-Error', 'invalid-token'); sendJson(response, 401, { error: 'Hub login required', code: 'HUB_AUTH_REQUIRED' }); return; }
      const backendKey = registrationKeys.get(backend.id);
      if (!backendKey) { sendJson(response, 503, { error: 'Backend has no active Hub registration key', code: 'HUB_BACKEND_KEY_UNAVAILABLE', backendId: backend.id }); return; }
      const assertion = createHubIdentityAssertion({ hubUserId: identity.id, username: identity.username, isAdmin: identity.isAdmin }, backend.id, backendKey);
      proxyHttp(request, response, backend, assertion);
      return;
    }
    if (pathname.startsWith('/session/')) {
      response.writeHead(308, { Location: `${config.basePath}${request.url}` }).end();
      return;
    }
    if (pathname === '/api-docs.html' || pathname === '/logo.svg' || pathname.startsWith('/logo-')
      || pathname.startsWith('/favicon.') || pathname.startsWith('/icons/')) {
      serveStatic(request, response, config, `${config.basePath}${pathname}`, listBackends());
      return;
    }
    if (pathname === config.basePath) { response.writeHead(308, { Location: `${config.basePath}/` }).end(); return; }
    if (pathname.startsWith(`${config.basePath}/`)) { serveStatic(request, response, config, pathname, listBackends()); return; }
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://hub.local').pathname;
    if (pathname === '/hub/register/ws') {
      if (!config.registryFile) {
        writeSocketError(socket, 503, 'Registration Disabled');
        return;
      }
      const backendId = new URL(request.url ?? '/', 'http://hub.local').searchParams.get('backend_id');
      const registered = backendId ? registeredBackends.get(backendId) : undefined;
      if (!registered) {
        writeSocketError(socket, 404, 'Backend Not Provisioned');
        return;
      }
      if (!registrationKeyMatches(request, registered.keyHash)) {
        writeSocketError(socket, 401, 'Unauthorized');
        return;
      }
      registrationServer.handleUpgrade(request, socket, head, (webSocket) => {
        registrationServer.emit('connection', webSocket, request);
      });
      return;
    }
    if (!PROXIED_SOCKET_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
      writeSocketError(socket, 404, 'Not Found');
      return;
    }
    if (!request.headers['x-cloudcli-backend'] && !new URL(request.url!, 'http://hub.local').searchParams.has('hub_backend')) {
      writeSocketError(socket, 400, 'Explicit Backend Required'); return;
    }
    const backend = selectedBackend(request, config, listBackends());
    if (!backend) { writeSocketError(socket, 400, 'Unknown Backend'); return; }
    if (!backend.online || !backend.url) { writeSocketError(socket, 503, 'Backend Offline'); return; }
    const upgradeUrl = new URL(request.url ?? '/', 'http://hub.local');
    const token = bearerToken(request) ?? upgradeUrl.searchParams.get('token');
    const identity = authService.authenticate(token);
    if (!identity) { writeSocketError(socket, 401, 'Hub Login Required'); return; }
    const backendKey = registrationKeys.get(backend.id);
    if (!backendKey) { writeSocketError(socket, 503, 'Backend Registration Key Unavailable'); return; }
    const assertion = createHubIdentityAssertion({ hubUserId: identity.id, username: identity.username, isAdmin: identity.isAdmin }, backend.id, backendKey);
    proxySocket(request, socket, head, backend as RoutableHubBackend, assertion);
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const socket of registrationServer.clients) socket.close(1001, 'Hub is shutting down');
    registrationServer.close();
  });
  return server;
}

/** Used by the Hub entry point to load static backend routes and the persistent managed-backend registry. */
export function loadHubConfiguration(): HubConfiguration {
  const configFile = process.env.HUB_BACKENDS_FILE;
  if (!configFile) throw new Error('HUB_BACKENDS_FILE is required');
  const registryFile = process.env.HUB_REGISTRY_FILE;
  const parsed = parseBackends(JSON.parse(fs.readFileSync(configFile, 'utf8')) as HubConfigFile);
  const appRoot = process.cwd();
  return {
    ...parsed,
    registryFile,
    authFile: process.env.HUB_AUTH_FILE ?? path.join(os.homedir(), '.cloudcli', 'hub-auth.json'),
    distDirectory: path.resolve(process.env.HUB_DIST_DIR ?? path.join(appRoot, 'dist')),
    publicDirectory: path.resolve(process.env.HUB_PUBLIC_DIR ?? path.join(appRoot, 'public')),
    basePath: normalizeBasePath(process.env.HUB_BASE_PATH ?? '/cloudcli'),
  };
}
