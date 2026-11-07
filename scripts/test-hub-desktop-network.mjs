// Real Chromium -> HTTPS protocol Request -> session.fetch -> HTTPS fixture.
// This isolated test trusts only its generated loopback certificate.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { networkForwardingOptions } from '../electron/hub/network-forwarding.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-network-'));
app.setPath('userData', path.join(dir, 'profile'));
let server; let win;
app.whenReady().then(async () => {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const cert = await fs.readFile(path.join(dir, 'cert'), 'utf8');
    const received = [];
    server = https.createServer({ key: await fs.readFile(path.join(dir, 'key')), cert }, async (req, res) => {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>fixture</body></html>'); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      received.push({ path: req.url, origin: req.headers.origin, auth: req.headers.authorization, body });
      res.writeHead(req.headers.origin === base.origin ? (req.url === '/hub/auth/login' ? 401 : 200) : 403); res.end('fixture');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = new URL(`https://127.0.0.1:${server.address().port}/cloudcli/`);
    const ses = session.fromPartition('network-fixture');
    ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' && request.certificate.data.trim() === cert.trim() ? 0 : -3));
    await ses.protocol.handle('https', request => ses.fetch(request.url, networkForwardingOptions(request, base.href)));
    win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(base.href);
    const results = await win.webContents.executeJavaScript(`(async () => {
      const login = await fetch('/hub/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'fictional',password:'fixture-only'})});
      const save = await fetch('/hub/config', {method:'POST', headers:{'Authorization':'Bearer fixture-only'}, body:'fixture-json'});
      const form = new FormData(); form.append('file', new Blob(['fixture-upload']), 'fixture.txt');
      const upload = await fetch('/hub/upload', {method:'POST', body:form});
      return [login.status,save.status,upload.status];
    })()`);
    assert.deepEqual(results, [401, 200, 200]);
    assert.equal(received[1].auth, 'Bearer fixture-only');
    assert.equal(received[1].body, 'fixture-json');
    assert.ok(received[2].body.includes('fixture-upload'));
    await win.loadURL(new URL('/outside/', base).href);
    assert.equal(await win.webContents.executeJavaScript("fetch('/hub/config',{method:'POST',body:'untrusted'}).then(r=>r.status)"), 403);
    console.log('REAL_HTTPS_LOGIN_JSON_MULTIPART_AND_UNTRUSTED_REFERRER_OK');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win?.destroy(); if(server) await new Promise(resolve => server.close(resolve)); await fs.rm(dir, {recursive:true,force:true}); app.exit(process.exitCode || 0); }
});
