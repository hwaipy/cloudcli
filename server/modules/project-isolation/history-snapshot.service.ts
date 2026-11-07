import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Used by the isolation exporter to enumerate metadata without buffering every transcript in one response. */
export function isolationHistoryManifestScript(): string {
  return String.raw`
const fs = require('fs'), path = require('path');
const root = process.env.CODEX_HOME;
const entries = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && (file.endsWith('.jsonl') || file.endsWith('.jsonl.zst'))) add(file);
  }
}
function add(file) {
  if (entries.length >= 4000) throw new Error('History manifest file count limit exceeded');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  entries.push({ path: path.relative(root, file), size: stat.size, mtimeMs: stat.mtimeMs });
}
walk(path.join(root, 'sessions'));
walk(path.join(root, 'archived_sessions'));
const index = path.join(root, 'session_index.jsonl');
if (fs.existsSync(index)) add(index);
process.stdout.write(JSON.stringify(entries));
`;
}

/** Used by the isolation exporter to read one bounded, regular history file, independently of other transcripts. */
export function isolationHistoryFileScript(): string {
  return String.raw`
const fs = require('fs'), path = require('path');
const root = fs.realpathSync(process.env.CODEX_HOME);
const relative = process.argv[1];
if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '..')
  || !(relative === 'session_index.jsonl' || /^(sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(relative))) {
  throw new Error('Invalid isolated history path');
}
const file = path.resolve(root, relative);
if (!file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) throw new Error('Invalid isolated history path');
const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('History file size limit exceeded');
  // Read at most the observed size: an actively growing file cannot defeat the memory bound.
  const bytes = Buffer.alloc(stat.size);
  let read = 0;
  while (read < bytes.length) {
    const length = fs.readSync(descriptor, bytes, read, bytes.length - read, read);
    if (!length) break;
    read += length;
  }
  process.stdout.write(JSON.stringify({ path: relative, data: bytes.subarray(0, read).toString('base64'), mtimeMs: stat.mtimeMs }));
} finally { fs.closeSync(descriptor); }
`;
}

/** Used by the isolation exporter to validate container-supplied metadata before choosing host paths or allocating file buffers. */
export function parseIsolationHistoryManifest(value: unknown): Array<{ path: string; size: number; mtimeMs: number }> {
  if (!Array.isArray(value) || value.length > 4000) throw new Error('Invalid isolated history manifest');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid isolated history manifest');
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.split('/').some((part) => !part || part === '..')
      || !(item.path === 'session_index.jsonl' || /^(sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(item.path))
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
      || typeof item.mtimeMs !== 'number' || !Number.isFinite(item.mtimeMs) || item.mtimeMs < 0 || item.mtimeMs > 8.64e15) {
      throw new Error('Invalid isolated history manifest');
    }
    return { path: item.path, size: item.size, mtimeMs: item.mtimeMs };
  });
}

/** Used by the isolated runtime exporter to atomically publish changed transcript bytes with their source mtime, without turning unrelated syncs into session activity. */
export async function publishIsolationHistorySnapshot(root: string, value: unknown): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid isolated history snapshot');
  const item = value as Record<string, unknown>;
  if (typeof item.path !== 'string' || typeof item.data !== 'string' || item.path.includes('\\') || item.path.split('/').some((part) => !part || part === '..')
    || !(item.path === 'session_index.jsonl' || /^(sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(item.path))
    || typeof item.mtimeMs !== 'number' || !Number.isFinite(item.mtimeMs) || item.mtimeMs < 0 || item.mtimeMs > 8.64e15) throw new Error('Invalid isolated history snapshot');
  const target = path.resolve(root, item.path);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Isolated history snapshot escaped its root');
  const bytes = Buffer.from(item.data, 'base64');
  const existing = await fs.readFile(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing?.equals(bytes)) return false;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    const modified = new Date(item.mtimeMs);
    await fs.utimes(temporary, modified, modified);
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return true;
}
