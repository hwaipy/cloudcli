import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix);

// Clash fake-IP DNS cannot establish an address's security boundary. Resolve the real IP over authenticated DoH instead.
// Bootstrap only fixed, TLS-authenticated resolver hosts through the host's DNS/TUN; connecting to a resolver's raw IP can bypass domain-based VPN routing.
async function resolveFakeAddress(hostname: string): Promise<Array<{ address: string; family: number }>> {
  for (const [servername, pathname] of [['cloudflare-dns.com', '/dns-query'], ['dns.google', '/resolve']]) {
    try {
      const answers = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        const request = https.get({ hostname: servername, servername, path: `${pathname}?name=${encodeURIComponent(hostname)}&type=A`, headers: { Host: servername, Accept: 'application/dns-json' }, timeout: 4_000 }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; if (body.length > 32_768) request.destroy(new Error('DNS response too large')); });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const payload = JSON.parse(body);
              const records = (payload.Answer ?? []).filter((record: { type: number; data: string }) => record.type === 1 && net.isIPv4(record.data));
              if (!records.length) throw new Error('No public DNS answer');
              resolve(records.map((record: { data: string }) => ({ address: record.data, family: 4 })));
            } catch (error) { reject(error); }
          });
        });
        request.on('timeout', () => request.destroy(new Error('DNS timeout')));
        request.on('error', reject);
      });
      return answers;
    } catch { /* Fail closed if no authenticated DNS resolver can provide real addresses. */ }
  }
  throw new Error('Cannot resolve real public addresses behind fake-IP DNS');
}

function trace(host: string, status: string): void {
  if (process.env.CLOUDCLI_ISOLATION_LOG_EGRESS === '1') console.info(`[Isolation egress] ${host} ${status}`);
}

// These service domains are operated by OpenAI, never by a project. A trusted host TUN
// may need their fake IP to retain domain routing. Arbitrary domains always use pinned
// real IPs; this narrow list cannot be extended by container input or configuration.
const trustedCodexServices = new Set(['chatgpt.com', 'ab.chatgpt.com', 'auth.openai.com', 'api.openai.com']);
async function tlsEndpoint(hostname: string, publicIp: string): Promise<string> {
  if (!trustedCodexServices.has(hostname.toLowerCase())) return publicIp;
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  if (answers.length && answers.every(({ address }) => /^198\.(18|19)\./.test(address))) return answers[0].address;
  return publicIp;
}

async function publicAddress(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!net.isIP(host) && answers.length && answers.every(({ address }) => /^198\.(18|19)\./.test(address))) answers = await resolveFakeAddress(host);
  if (!answers.length || answers.some(({ address, family }) => family === 4
    ? blocked.check(address, 'ipv4')
    // Permit global unicast only, excluding IPv4-mapped and documentation addresses.
    : !/^[23][0-9a-f]{3}:/i.test(address) || /^2001:db8:/i.test(address))) {
    throw new Error('Private, loopback and reserved network destinations are not allowed');
  }
  return (answers.find(({ family }) => family === 4) ?? answers[0]).address;
}

// Only operator configuration selects this upstream. Container input still passes publicAddress first.
function configuredUpstreamProxy(): URL | undefined {
  const value = process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY;
  if (!value) return undefined;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('Isolation upstream must be an HTTP(S) proxy URL without credentials, path or query');
  }
  return proxy;
}

async function openEgressConnection(address: string, port: number, proxy: URL | undefined): Promise<net.Socket> {
  if (!proxy) return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    socket.setTimeout(30_000, () => socket.destroy(new Error('Egress connection timeout')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.setTimeout(0); socket.removeListener('error', reject); resolve(socket); });
  });
  const authority = `${net.isIPv6(address) ? `[${address}]` : address}:${port}`;
  return new Promise((resolve, reject) => {
    // Pin the validated destination IP even when using Clash; never delegate destination DNS to it.
    const request = (proxy.protocol === 'https:' ? https : http).request(proxy, {
      method: 'CONNECT', path: authority, headers: { Host: authority }, agent: false,
    });
    const timer = setTimeout(() => request.destroy(new Error('Isolation upstream connection timeout')), 30_000);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.once('connect', (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error('Isolation upstream refused connection')); return; }
      socket.pause();
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

/** Used by the isolation runtime to provide a Unix-socket HTTP proxy; resolves and pins public IPs before connecting. */
export async function startIsolationEgress(socketPath: string, options: { allowSsh?: boolean } = {}): Promise<http.Server> {
  const upstreamProxy = configuredUpstreamProxy();
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const exists = await fs.lstat(socketPath).then(() => true).catch(() => false);
  if (exists) {
    const active = await new Promise<boolean>((resolve) => {
      const probe = net.connect(socketPath);
      probe.setTimeout(500);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => { probe.destroy(); resolve(false); });
      probe.once('timeout', () => { probe.destroy(); resolve(true); });
    });
    if (active) throw new Error('Another isolation egress process already owns this state directory');
    await fs.rm(socketPath, { force: true });
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '');
      if (url.protocol !== 'http:' || url.username || url.password || (url.port && url.port !== '80')) throw new Error('Only HTTP port 80 and CONNECT port 443 are supported');
      trace(url.hostname, 'HTTP request');
      const address = await publicAddress(url.hostname);
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const connection = upstreamProxy ? await openEgressConnection(address, 80, upstreamProxy) : undefined;
      if (response.destroyed) { connection?.destroy(); return; }
      const upstream = http.request({ host: address, port: 80, ...(connection ? { createConnection: () => connection } : {}), method: request.method, path: url.pathname + url.search, headers, timeout: 60_000 }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
      connection?.resume();
    })().catch(() => { response.writeHead(403); response.end('Isolation egress destination denied'); });
  });
  server.on('connect', (request, client, head) => {
    void (async () => {
      const url = new URL(`https://${request.url}`);
      const port = Number(url.port || 443);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535 || (!options.allowSsh && port !== 443)) throw new Error('Invalid CONNECT destination');
      trace(url.hostname, 'CONNECT request');
      const address = await publicAddress(url.hostname);
      trace(url.hostname, `resolved ${address}`);
      if (client.destroyed) return;
      const endpoint = port === 443 && !upstreamProxy ? await tlsEndpoint(url.hostname, address) : address;
      const upstream = await openEgressConnection(endpoint, port, upstreamProxy);
      if (client.destroyed) { upstream.destroy(); return; }
      trace(url.hostname, 'connected');
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('error', (error) => { trace(url.hostname, `connection failed ${(error as NodeJS.ErrnoException).code ?? ''}`); client.destroy(); });
      upstream.on('close', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      client.pipe(upstream); upstream.pipe(client);
      upstream.resume();
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.maxConnections = 128;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  server.unref();
  return server;
}
