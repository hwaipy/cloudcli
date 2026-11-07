// Signed-to-signed native update test. Only disposable apps, profile, bundle ID,
// cache and loopback services are used; no installed application is touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeDesktopManifest } from './desktop-web-manifest.mjs';
const require = createRequire(import.meta.url); const asar = require('@electron/asar');
if (process.platform !== 'darwin' || !process.env.CSC_NAME || !process.env.CSC_KEYCHAIN || !process.env.CLOUDCLI_TEST_SIGNED_APP) throw new Error('Requires a signed Mac app, CSC_NAME and unlocked CSC_KEYCHAIN');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-shell-update-'));
const source = path.join(root, 'source/CloudCLI.app'); const target = path.join(root, 'target/CloudCLI.app');
const site = path.join(root, 'site'); const profile = path.join(root, 'profile');
const fixtureId = `cn.hwaipy.cloudcli.fixture.${path.basename(root).replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const debugPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
let metadata; let zip; let socket; let child; let logs = '';
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/updates/latest-mac.yml' && metadata) { response.end(JSON.stringify(metadata)); return; }
    if (pathname === '/updates/fixture.zip' && zip) { response.setHeader('Content-Length', zip.length); response.end(zip); return; }
    if (!pathname.startsWith('/cloudcli/')) { response.writeHead(404); response.end(); return; }
    const name = pathname.slice('/cloudcli/'.length) || 'index.html';
    if (name.includes('..')) throw Error('invalid path');
    const body = await fs.readFile(path.join(site, name));
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : 'application/json'); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/cloudcli/`;
let sequence = 0;
async function attach(timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = pages.find(item => item.type === 'page' && item.url.startsWith(base));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return ws; }
    } catch {}
    await delay(250);
  }
  throw Error(`Fixture app did not appear: ${logs.slice(-3000)}`);
}
function call(method, params = {}) {
  const ws = socket; const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', listener); ws.off('close', closed); };
    const timer = setTimeout(() => { cleanup(); reject(Error('CDP timeout')); }, 15_000);
    const closed = () => { cleanup(); reject(Error('App restarted')); };
    const listener = data => { const reply = JSON.parse(data); if (reply.id === id) { cleanup(); if (reply.error || reply.result?.exceptionDetails) reject(Error(JSON.stringify(reply))); else resolve(reply.result); } };
    ws.on('message', listener); ws.once('close', closed); ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async expression => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
try {
  await fs.mkdir(site, { recursive: true }); await fs.writeFile(path.join(site, 'index.html'), '<html><body>isolated shell update fixture</body></html>'); await fs.writeFile(path.join(site, 'boot-assets.json'), '{}'); await writeDesktopManifest(site);
  const original = JSON.parse(asar.extractFile(path.join(process.env.CLOUDCLI_TEST_SIGNED_APP, 'Contents/Resources/app.asar'), 'package.json'));
  assert.equal(original.cloudcliUnsignedTest, false); const targetVersion = original.version;
  const [major, minor, patch] = targetVersion.split('.').map(Number); assert.ok(patch > 0);
  const oldVersion = `${major}.${minor}.${patch - 1}`;
  for (const [destination, version] of [[source, oldVersion], [target, targetVersion]]) {
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.cp(process.env.CLOUDCLI_TEST_SIGNED_APP, destination, { recursive: true, verbatimSymlinks: true });
    const archive = path.join(destination, 'Contents/Resources/app.asar'); const extracted = `${destination}.contents`;
    asar.extractAll(archive, extracted);
    const pkg = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8')); pkg.version = version;
    await fs.writeFile(path.join(extracted, 'package.json'), JSON.stringify(pkg));
    const entry = path.join(extracted, 'electron/hub/main.mjs');
    const injection = `process.env.CLOUDCLI_DESKTOP_URL=${JSON.stringify(base)}; process.env.CLOUDCLI_DESKTOP_USER_DATA=${JSON.stringify(profile)}; process.env.CLOUDCLI_DESKTOP_UPDATE_URL=${JSON.stringify(new URL('/updates/', base).href)}; delete process.env.CLOUDCLI_DESKTOP_DISABLE_SHELL_UPDATES; app.commandLine.appendSwitch('remote-debugging-port',${JSON.stringify(String(debugPort))}); app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');\n`;
    await fs.writeFile(entry, (await fs.readFile(entry, 'utf8')).replace('const root =', injection + 'const root ='));
    await fs.rm(archive); await asar.createPackage(extracted, archive); await fs.rm(extracted, { recursive: true });
    const plist = path.join(destination, 'Contents/Info.plist');
    const integrity = JSON.parse(execFileSync('plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    integrity['Resources/app.asar'] = { algorithm: 'SHA256', hash: createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex') };
    execFileSync('plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify(integrity), plist]);
    for (const [key, value] of [['CFBundleIdentifier', fixtureId], ['CFBundleVersion', version], ['CFBundleShortVersionString', version]]) execFileSync('plutil', ['-replace', key, '-string', value, plist]);
    await fs.writeFile(path.join(destination, 'Contents/Resources/app-update.yml'), `provider: generic\nurl: ${new URL('/updates/', base).href}\nupdaterCacheDirName: ${fixtureId}\n`);
    execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--keychain', process.env.CSC_KEYCHAIN, '--entitlements', path.resolve('electron/hub/entitlements.mac.plist'), '--sign', process.env.CSC_NAME, destination], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', destination]);
  }
  const zipPath = path.join(root, 'fixture.zip'); execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', target, zipPath]);
  zip = await fs.readFile(zipPath); const sha512 = createHash('sha512').update(zip).digest('base64');
  metadata = { version: targetVersion, files: [{ url: 'fixture.zip', size: zip.length, sha512 }], path: 'fixture.zip', sha512, releaseDate: new Date().toISOString() };
  child = spawn(path.join(source, 'Contents/MacOS/CloudCLI'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  socket = await attach();
  const deadline = Date.now() + 120_000;
  let state;
  while (Date.now() < deadline) { state = await evaluate('window.cloudcliDesktopUpdates?.state()'); if (!state) { await delay(100); continue; } if (state.shell.phase === 'ready') break; if (state.shell.phase === 'error') throw Error(state.shell.error); await delay(250); }
  assert.equal(state.version, oldVersion); assert.equal(state.shell.phase, 'ready'); assert.equal(state.shell.version, targetVersion);
  console.log('SIGNED_SHELL_DOWNLOAD_READY_WITHOUT_INSTALL_OK');
  await evaluate('window.cloudcliDesktopUpdates.apply()').catch(() => {}); socket.close(); await delay(1500); socket = await attach();
  let installed;
  const restartDeadline = Date.now() + 60_000;
  while (Date.now() < restartDeadline) {
    try { installed = await evaluate('window.cloudcliDesktopUpdates?.state()'); if (installed?.version === targetVersion) break; }
    catch { socket.close(); socket = await attach(); }
    await delay(100);
  }
  assert.equal(installed?.version, targetVersion);
  assert.equal(execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(source, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(), targetVersion);
  execFileSync('codesign', ['--verify', '--deep', '--strict', source]);
  console.log(`SIGNED_NATIVE_INSTALL_AND_RESTART_OK ${oldVersion} -> ${targetVersion}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch {} socket.close(); }
  // A restarted fixture need not retain the original child PID; select only its unique bundle path.
  const processes = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  for (const line of processes.split('\n')) { const match = /^\s*(\d+)\s+(.*)$/.exec(line); if (match?.[2].startsWith(path.join(source, 'Contents/MacOS/CloudCLI'))) try { process.kill(Number(match[1]), 'SIGTERM'); } catch {} }
  await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.join(os.homedir(), 'Library/Caches', fixtureId), { recursive: true, force: true });
  await fs.rm(path.join(os.homedir(), 'Library/Caches', `${fixtureId}.ShipIt`), { recursive: true, force: true });
}
