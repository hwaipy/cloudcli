import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import { executeIsolationDocker } from './isolation-docker.service.js';
let building: Promise<string> | null = null;

/** Used by the project isolation service to install a pinned CLI into a minimal runtime image using the backend's already installed, pinned CLI binaries. */
export async function ensureIsolationImage(stateRoot: string): Promise<string> {
  if (building) return building;
  building = (async () => {
    const require = createRequire(import.meta.url);
    const launcher = require.resolve('@openai/codex/bin/codex.js');
    const pkg = JSON.parse(await fs.readFile(path.resolve(path.dirname(launcher), '../package.json'), 'utf8'));
    const version = String(pkg.version);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid bundled Codex version');
    const image = `cloudcli-codex-isolated:v2-ssh1-${version}`;
    try { await executeIsolationDocker(['image', 'inspect', image]); return image; } catch { /* Build a missing image. */ }
    const context = path.join(stateRoot, '.image-context');
    await fs.mkdir(context, { recursive: true, mode: 0o700 });
    const nativeName = `@openai/codex-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const nativeRoot = path.dirname(require.resolve(`${nativeName}/package.json`));
    await fs.cp(path.resolve(path.dirname(launcher), '..'), path.join(context, 'codex'), { recursive: true });
    await fs.cp(nativeRoot, path.join(context, 'codex-native'), { recursive: true });
    const mirror = process.env.CLOUDCLI_ISOLATION_APT_MIRROR === 'tuna' ? 'https://mirrors.tuna.tsinghua.edu.cn' : 'https://deb.debian.org';
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM node:24-bookworm-slim\nRUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\\n'))" && sed -i 's|http://deb.debian.org|${mirror}|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends git python3 python3-venv ca-certificates ripgrep curl bash openssh-client util-linux && rm -rf /var/lib/apt/lists/*\nCOPY codex /opt/cloudcli/node_modules/@openai/codex\nCOPY codex-native /opt/cloudcli/node_modules/${nativeName}\nRUN ln -s /opt/cloudcli/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex && codex --version\nCOPY forwarder.cjs /opt/cloudcli/forwarder.cjs\nRUN printf 'Acquire::http::Proxy "http://127.0.0.1:18080";\\nAcquire::https::Proxy "http://127.0.0.1:18080";\\nAPT::Sandbox::User "root";\\n' > /etc/apt/apt.conf.d/90-cloudcli-proxy\nENV HOME=/home/codex HTTP_PROXY=http://127.0.0.1:18080 HTTPS_PROXY=http://127.0.0.1:18080 http_proxy=http://127.0.0.1:18080 https_proxy=http://127.0.0.1:18080 NO_PROXY= no_proxy=\nENTRYPOINT ["node", "/opt/cloudcli/forwarder.cjs"]\n`);
    await fs.writeFile(path.join(context, 'forwarder.cjs'), `const net=require('node:net');net.createServer(client=>{const upstream=net.connect('/run/cloudcli-egress/proxy.sock');client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream);upstream.pipe(client)}).listen(18080,'127.0.0.1');`);
    await executeIsolationDocker(['build', '--tag', image, context], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    return image;
  })();
  try { return await building; } finally { building = null; }
}
