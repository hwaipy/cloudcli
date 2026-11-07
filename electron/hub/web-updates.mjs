import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const MAX_TOTAL = 256 * 1024 * 1024;

/** Validates untrusted update metadata before constructing cache paths or network URLs. */
export function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.id) || !Array.isArray(manifest.assets) || manifest.assets.length > 4000) throw new Error('Invalid web update manifest');
  const names = new Set(); let total = 0;
  for (const asset of manifest.assets) {
    if (typeof asset.file !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(asset.file) || asset.file.startsWith('/') || asset.file.split('/').some((part) => !part || part === '..' || part === '.') || names.has(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_TOTAL) throw new Error('Invalid web update asset');
    names.add(asset.file); total += asset.bytes;
  }
  if (total > MAX_TOTAL || !names.has('index.html') || !names.has('boot-assets.json') || hash(JSON.stringify(manifest.assets)) !== manifest.id) throw new Error('Invalid web update graph');
  return manifest;
}

/** Stores verified assets by content hash; a downloaded release stays pending until the user applies it. */
export class WebUpdates {
  constructor({ baseUrl, directory, fetch, onState = () => {} }) {
    this.base = new URL(baseUrl); this.directory = directory; this.fetch = fetch; this.onState = onState;
    this.active = null; this.pending = null; this.checking = null; this.saving = Promise.resolve();
  }
  file(asset) { return path.join(this.directory, 'files', asset.sha256); }
  async verified(asset) { try { const data = await fs.readFile(this.file(asset)); return data.length === asset.bytes && hash(data) === asset.sha256; } catch { return false; } }
  async save() {
    // Serialize metadata writes when a user applies during a background check.
    this.saving = this.saving.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'state.json');
      await fs.writeFile(`${target}.tmp`, JSON.stringify({ origin: this.base.href, active: this.active, pending: this.pending }));
      await fs.rename(`${target}.tmp`, target);
    });
    return this.saving;
  }
  async initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (saved.origin === this.base.href) {
        const active = validateManifest(saved.active);
        if ((await Promise.all(active.assets.map((asset) => this.verified(asset)))).every(Boolean)) this.active = active;
        if (saved.pending) {
          const pending = validateManifest(saved.pending);
          if ((await Promise.all(pending.assets.map((asset) => this.verified(asset)))).every(Boolean)) this.pending = pending;
        }
      }
    } catch { /* First install or corrupt cache: rebuild it from the trusted origin. */ }
    if (!this.active) { await this.check(); await this.apply(); }
    const retained = new Set([...(this.active?.assets ?? []), ...(this.pending?.assets ?? [])].map((asset) => asset.sha256));
    for (const file of await fs.readdir(path.join(this.directory, 'files')).catch(() => [])) {
      if (/^[a-f0-9]{64}(?:\.tmp)?$/.test(file) && !retained.has(file)) await fs.rm(path.join(this.directory, 'files', file)).catch(() => {});
    }
  }
  async check() {
    if (this.checking) return this.checking;
    this.checking = this.download().finally(() => { this.checking = null; });
    return this.checking;
  }
  async download() {
    const response = await this.fetch(new URL('desktop-assets.json', this.base).href, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Web update check failed: ${response.status}`);
    const candidate = validateManifest(await response.json());
    if (candidate.id === this.active?.id) { this.pending = null; await this.save(); this.onState({ phase: 'idle' }); return; }
    await fs.mkdir(path.join(this.directory, 'files'), { recursive: true });
    let done = 0; const total = candidate.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    for (const asset of candidate.assets) {
      if (!await this.verified(asset)) {
        const result = await this.fetch(new URL(asset.file, this.base).href, { signal: AbortSignal.timeout(60_000) });
        if (!result.ok) throw new Error(`Asset download failed: ${result.status}`);
        const chunks = []; let size = 0;
        for await (const chunk of result.body) { size += chunk.length; if (size > asset.bytes) throw new Error('Asset size exceeded'); chunks.push(chunk); this.onState({ phase: 'downloading', percent: Math.round((done + size) / Math.max(total, 1) * 100) }); }
        const data = Buffer.concat(chunks);
        if (data.length !== asset.bytes || hash(data) !== asset.sha256) throw new Error('Asset integrity verification failed');
        await fs.writeFile(`${this.file(asset)}.tmp`, data); await fs.rename(`${this.file(asset)}.tmp`, this.file(asset));
      }
      done += asset.bytes;
    }
    if (candidate.id === this.active?.id) { this.pending = null; await this.save(); this.onState({ phase: 'idle' }); return; }
    this.pending = candidate; await this.save(); this.onState({ phase: 'ready', version: candidate.id.slice(0, 8) });
  }
  async apply() { if (!this.pending) return; this.active = this.pending; this.pending = null; await this.save(); }
  async response(url, destination) {
    if (!this.active) return null;
    const parsed = new URL(url);
    if (parsed.origin !== this.base.origin || !parsed.pathname.startsWith(this.base.pathname)) return null;
    const relative = parsed.pathname.slice(this.base.pathname.length);
    const file = destination === 'document' && (!relative || relative.startsWith('session/')) ? 'index.html' : relative;
    const asset = this.active.assets.find((item) => item.file === file);
    if (!asset) return null;
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', wasm: 'application/wasm' };
    return new Response(await fs.readFile(this.file(asset)), { headers: { 'content-type': types[file.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-store' } });
  }
}
