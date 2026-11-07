import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebUpdates, validateManifest } from '../web-updates.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function release(version) {
  const bodies = { 'index.html': `<html>${version}</html>`, 'boot-assets.json': '{}', 'assets/shared.js': 'shared', 'assets/main.js': `version ${version}` };
  const assets = Object.entries(bodies).map(([file, body]) => ({ file, bytes: Buffer.byteLength(body), sha256: hash(body) }));
  return { manifest: { format: 1, assets, id: hash(JSON.stringify(assets)) }, bodies };
}
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-web-update-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
test('downloads changed bytes, stages without applying, preserves old UI and applies only on request', async () => fixture(async (directory) => {
  let current = release('one'); const fetched = [];
  const fetch = async (url) => { const file = new URL(url).pathname.replace('/cloudcli/', ''); fetched.push(file); return new Response(file === 'desktop-assets.json' ? JSON.stringify(current.manifest) : current.bodies[file]); };
  const updater = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch });
  await updater.initialize(); const old = updater.active.id;
  fetched.length = 0; current = release('two'); await updater.check();
  assert.equal(updater.active.id, old); assert.equal(updater.pending.id, current.manifest.id);
  assert.ok(!fetched.includes('assets/shared.js')); assert.ok(!fetched.includes('boot-assets.json'));
  assert.match(await (await updater.response('https://example.com/cloudcli/session/one', 'document')).text(), /one/);
  assert.equal(await updater.response('https://example.com/api/projects', ''), null);
  const restarted = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch });
  await restarted.initialize(); assert.equal(restarted.active.id, old); assert.equal(restarted.pending.id, current.manifest.id);
  await restarted.apply(); assert.match(await (await restarted.response('https://example.com/cloudcli/', 'document')).text(), /two/);
}));
test('partial or corrupt downloads never replace a working release', async () => fixture(async (directory) => {
  let current = release('one'); let corrupt = false;
  const updater = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch: async (url) => {
    const file = new URL(url).pathname.replace('/cloudcli/', '');
    return new Response(file === 'desktop-assets.json' ? JSON.stringify(current.manifest) : corrupt ? 'bad' : current.bodies[file]);
  } });
  await updater.initialize(); const old = updater.active.id;
  current = release('two'); corrupt = true;
  await assert.rejects(updater.check(), /verification|size/);
  assert.equal(updater.active.id, old); assert.equal(updater.pending, null);
}));
test('rejects traversal, duplicate assets, forged graph fingerprints and oversized manifests', () => {
  const good = release('one').manifest;
  for (const file of ['../outside', '/outside', 'assets/../../x', 'https://evil.test/x', 'assets/%2e%2e/x']) {
    assert.throws(() => validateManifest({ ...good, assets: [{ ...good.assets[0], file }] }));
  }
  assert.throws(() => validateManifest({ ...good, id: '0'.repeat(64) }));
  assert.throws(() => validateManifest({ ...good, assets: [...good.assets, good.assets[0]] }));
});
test('a server rollback withdraws a previously downloaded candidate', async () => fixture(async (directory) => {
  let current = release('one');
  const updater = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch: async (url) => { const file = new URL(url).pathname.replace('/cloudcli/', ''); return new Response(file === 'desktop-assets.json' ? JSON.stringify(current.manifest) : current.bodies[file]); } });
  await updater.initialize(); current = release('two'); await updater.check(); assert.ok(updater.pending);
  current = release('one'); await updater.check(); assert.equal(updater.pending, null);
}));
test('applying during a repeated background check leaves consistent metadata and no redundant pending update', async () => fixture(async (directory) => {
  let current = release('one');
  const fetch = async (url) => { const file = new URL(url).pathname.replace('/cloudcli/', ''); return new Response(file === 'desktop-assets.json' ? JSON.stringify(current.manifest) : current.bodies[file]); };
  const updater = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch });
  await updater.initialize(); current = release('two'); await updater.check();
  const original = updater.verified.bind(updater); let unblock; let entered;
  const barrier = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  updater.verified = async (asset) => { entered(); await gate; return original(asset); };
  const check = updater.check(); await barrier; await updater.apply(); unblock(); await check;
  assert.equal(updater.active.id, current.manifest.id); assert.equal(updater.pending, null);
  const restarted = new WebUpdates({ directory, baseUrl: 'https://example.com/cloudcli/', fetch });
  await restarted.initialize(); assert.equal(restarted.active.id, current.manifest.id); assert.equal(restarted.pending, null);
}));
