import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

import mime from 'mime-types';

type HubBackend = { id: string; name: string; url: URL };
type HubConfiguration = {
  backends: HubBackend[];
  defaultBackendId: string;
  distDirectory: string;
  publicDirectory: string;
  basePath: string;
};

type HubConfigFile = {
  backends?: Array<{ id?: unknown; name?: unknown; url?: unknown }>;
  defaultBackendId?: unknown;
};

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

function selectedBackend(request: IncomingMessage, config: HubConfiguration): HubBackend | null {
  const url = new URL(request.url ?? '/', 'http://hub.local');
  const explicitId = request.headers['x-cloudcli-backend'] ?? url.searchParams.get('hub_backend');
  if (explicitId !== undefined && explicitId !== null) {
    return typeof explicitId === 'string'
      ? config.backends.find((backend) => backend.id === explicitId) ?? null
      : null;
  }
  const cookie = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const id = cookie?.slice(COOKIE_NAME.length + 1);
  return config.backends.find((backend) => backend.id === id)
    ?? config.backends.find((backend) => backend.id === config.defaultBackendId)!;
}

function selectedBackendOrError(request: IncomingMessage, response: ServerResponse, config: HubConfiguration): HubBackend | null {
  const backend = selectedBackend(request, config);
  if (!backend) sendJson(response, 400, { error: 'Unknown backend' });
  return backend;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
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

function proxyHeaders(request: IncomingMessage, backend: HubBackend): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: backend.url.host };
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

function proxyHttp(request: IncomingMessage, response: ServerResponse, backend: HubBackend): void {
  const transport = backend.url.protocol === 'https:' ? https : http;
  const upstream = transport.request(backend.url, {
    method: request.method,
    path: request.url,
    headers: proxyHeaders(request, backend),
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

function proxySocket(request: IncomingMessage, socket: Duplex, head: Buffer, backend: HubBackend): void {
  const transport = backend.url.protocol === 'https:' ? https : http;
  const upstream = transport.request(backend.url, {
    method: request.method,
    path: request.url,
    headers: proxyHeaders(request, backend),
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

function serveStatic(request: IncomingMessage, response: ServerResponse, config: HubConfiguration, pathname: string): void {
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
      const backendId = selectedBackend(request, config)?.id ?? config.defaultBackendId;
      const runtimeConfig = `<script>window.__ROUTER_BASENAME__=${JSON.stringify(config.basePath)};window.__CLOUDCLI_BACKEND_ID__=${JSON.stringify(backendId)};</script>`;
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

function selectionPage(config: HubConfiguration, selectedId: string): string {
  const choices = config.backends.map(({ id, name }) =>
    `<button data-id="${id}"${id === selectedId ? ' disabled' : ''}>${name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}${id === selectedId ? ' · 当前' : ''}</button>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudCLI Hub</title><style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px;color:#222}button{display:block;width:100%;text-align:left;margin:12px 0;padding:14px;border:1px solid #ddd;border-radius:10px;background:#fff;font:inherit;cursor:pointer}button:disabled{background:#eef3ff;cursor:default}a{color:#2563eb}</style><h1>选择服务器</h1>${choices}<p><a href="${config.basePath}/">返回 CloudCLI</a></p><script>document.querySelectorAll('button[data-id]').forEach(button=>button.onclick=async()=>{button.disabled=true;const response=await fetch('/hub/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.id})});if(response.ok)location.href=${JSON.stringify(`${config.basePath}/`)};else{button.disabled=false;alert('切换失败')}})</script></html>`;
}

/** Used by the standalone Hub entry point and tests to route one selected backend's HTTP and WebSocket traffic. */
export function createHubServer(config: HubConfiguration): http.Server {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://hub.local').pathname;
    if (pathname === '/hub/health') { sendJson(response, 200, { status: 'ok' }); return; }
    if (pathname === '/hub/backends') {
      sendJson(response, 200, {
        selectedBackendId: selectedBackend(request, config)?.id ?? config.defaultBackendId,
        backends: config.backends.map(({ id, name }) => ({ id, name })),
      });
      return;
    }
    if (pathname === '/hub' || pathname === '/hub/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(selectionPage(config, selectedBackend(request, config)?.id ?? config.defaultBackendId));
      return;
    }
    if (pathname === '/hub/select') {
      if (request.method !== 'POST' || !isSameOrigin(request) || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        sendJson(response, 403, { error: 'Selection requires a same-origin JSON POST' });
        return;
      }
      let body = '';
      let tooLarge = false;
      request.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        body += chunk.toString('utf8');
        if (body.length > 4096) {
          tooLarge = true;
          sendJson(response, 413, { error: 'Selection request is too large' });
        }
      });
      request.on('end', () => {
        if (tooLarge) return;
        let id: unknown;
        try { id = (JSON.parse(body) as { id?: unknown }).id; } catch { /* Invalid body. */ }
        if (typeof id !== 'string' || !config.backends.some((backend) => backend.id === id)) {
          sendJson(response, 400, { error: 'Unknown backend' });
          return;
        }
        const secure = request.socket instanceof TLSSocket || request.headers['x-forwarded-proto'] === 'https';
        response.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
        sendJson(response, 200, { selectedBackendId: id });
      });
      return;
    }
    if (PROXIED_HTTP_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
      const backend = selectedBackendOrError(request, response, config);
      if (backend) proxyHttp(request, response, backend);
      return;
    }
    if (pathname.startsWith('/session/')) {
      response.writeHead(308, { Location: `${config.basePath}${request.url}` }).end();
      return;
    }
    if (pathname === '/api-docs.html' || pathname === '/logo.svg' || pathname.startsWith('/logo-')
      || pathname.startsWith('/favicon.') || pathname.startsWith('/icons/')) {
      serveStatic(request, response, config, `${config.basePath}${pathname}`);
      return;
    }
    if (pathname === config.basePath) { response.writeHead(308, { Location: `${config.basePath}/` }).end(); return; }
    if (pathname.startsWith(`${config.basePath}/`)) { serveStatic(request, response, config, pathname); return; }
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://hub.local').pathname;
    if (!PROXIED_SOCKET_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
      writeSocketError(socket, 404, 'Not Found');
      return;
    }
    const backend = selectedBackend(request, config);
    if (!backend) { writeSocketError(socket, 400, 'Unknown Backend'); return; }
    proxySocket(request, socket, head, backend);
  });
  return server;
}

/** Used by the Hub entry point to load a fixed backend allowlist from a JSON file at startup. */
export function loadHubConfiguration(): HubConfiguration {
  const configFile = process.env.HUB_BACKENDS_FILE;
  if (!configFile) throw new Error('HUB_BACKENDS_FILE is required');
  const parsed = parseBackends(JSON.parse(fs.readFileSync(configFile, 'utf8')) as HubConfigFile);
  const appRoot = process.cwd();
  return {
    ...parsed,
    distDirectory: path.resolve(process.env.HUB_DIST_DIR ?? path.join(appRoot, 'dist')),
    publicDirectory: path.resolve(process.env.HUB_PUBLIC_DIR ?? path.join(appRoot, 'public')),
    basePath: normalizeBasePath(process.env.HUB_BASE_PATH ?? '/cloudcli'),
  };
}
