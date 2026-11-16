import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeDesktopManifest } from './desktop-web-manifest.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-electron-test-'));
const site = path.join(root, 'site'); const userData = path.join(root, 'profile');
await fs.mkdir(path.join(site, 'assets'), { recursive: true });
async function publish(version) {
  await fs.writeFile(path.join(site, 'index.html'), `<html><body data-fixture="${version}">CloudCLI desktop test ${version}</body></html>`);
  await fs.writeFile(path.join(site, 'boot-assets.json'), '{}');
  await fs.writeFile(path.join(site, 'assets/shared.js'), 'same bytes');
  await writeDesktopManifest(site);
}
await publish('one');
const server = http.createServer(async (request, response) => {
  try {
    const relative = new URL(request.url, 'http://localhost').pathname.replace(/^\/cloudcli\//, '') || 'index.html';
    if (relative.includes('..')) throw new Error('invalid path');
    const body = await fs.readFile(path.join(site, relative));
    response.writeHead(200, { 'content-type': relative.endsWith('.json') ? 'application/json' : relative.endsWith('.html') ? 'text/html' : 'text/javascript' }); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const temporaryPort = net.createServer(); await new Promise((resolve) => temporaryPort.listen(0, '127.0.0.1', resolve));
const debugPort = temporaryPort.address().port; await new Promise((resolve) => temporaryPort.close(resolve));
const base = `http://127.0.0.1:${server.address().port}/cloudcli/`;
const binary = process.env.CLOUDCLI_TEST_DESKTOP_BINARY || (process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : 'node_modules/electron/dist/electron');
const child = spawn(binary, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', ...(process.env.CLOUDCLI_TEST_DESKTOP_BINARY ? [] : ['electron/hub/main.mjs'])], { env: { ...process.env, CLOUDCLI_DESKTOP_URL: base, CLOUDCLI_DESKTOP_USER_DATA: userData, CLOUDCLI_DESKTOP_DISABLE_SHELL_UPDATES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stderr.on('data', (data) => { logs += data; }); child.stdout.on('data', (data) => { logs += data; });
let socket;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function attach() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = pages.find((item) => item.type === 'page' && item.url.startsWith(base));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        return ws;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`Desktop did not load: ${logs.slice(-3000)}`);
}
let sequence = 0;
function call(method, params = {}) {
  const ws = socket; const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`CDP timed out: ${method}`)); }, 15_000);
    const cleanup = () => { clearTimeout(timeout); ws.off('message', listener); ws.off('close', closed); };
    const closed = () => { cleanup(); reject(new Error('Desktop restarted')); };
    const listener = (data) => { const message = JSON.parse(data); if (message.id === id) { cleanup(); if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message))); else resolve(message.result); } };
    ws.on('message', listener); ws.once('close', closed); ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
// CDP exposes a page before navigation has produced its body, especially after
// app.relaunch(). Wait for the document, then assert the actual fixture version.
async function waitForDocument() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('document.readyState === "complete" && Boolean(document.body)')) return;
    await delay(100);
  }
  throw new Error('Desktop document did not finish loading');
}
try {
  socket = await attach();
  await waitForDocument();
  for (let i = 0; i < 40 && !await evaluate('Boolean(window.cloudcliDesktopUpdates)'); i++) await delay(100);
  assert.equal(await evaluate('Boolean(window.cloudcliDesktopUpdates)'), true);
  assert.equal(await evaluate('typeof require'), 'undefined');
  // The native notification bridge is available only inside the trusted page.
  assert.equal(await evaluate('typeof window.cloudcliDesktopNotifications?.receive'), 'function');
  const notificationState = await evaluate('window.cloudcliDesktopNotifications.scope("fixture-account")');
  assert.equal(notificationState.desktopNotifications.enabled, false);
  assert.equal(notificationState.desktopNotifications.unreadCount, 0);
  assert.equal(await evaluate('window.cloudcliDesktopNotifications.receive({})'), false);
  await evaluate('window.cloudcliDesktopNotifications.scope("")');
  console.log('NATIVE_NOTIFICATION_BRIDGE_ACCOUNT_SCOPE_OK');
  assert.equal(await evaluate('document.body.dataset.fixture'), 'one');
  await publish('two');
  const state = await evaluate('window.cloudcliDesktopUpdates.check()');
  assert.equal(state.web.phase, 'ready');
  assert.equal(await evaluate('document.body.dataset.fixture'), 'one', 'download must not reload the user view');
  console.log('DOWNLOAD_READY_WITHOUT_RELOAD_OK');
  // Applying must actually restart Electron, not just change a renderer label.
  await evaluate('window.cloudcliDesktopUpdates.apply()').catch(() => {});
  socket.close(); await delay(1000); socket = await attach();
  await waitForDocument();
  assert.equal(await evaluate('document.body.dataset.fixture'), 'two');
  console.log('NATIVE_RESTART_AND_APPLY_OK');
  await call('Browser.close').catch(() => {}); socket.close();
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch {} socket.close(); }
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
