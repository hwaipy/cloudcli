import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const execute = promisify(execFile);

async function readKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout;
  } catch { return null; } // Do not log subprocess errors: stdout can contain credentials.
}

/** Shared by Claude authentication and quota readers; credentials never leave the backend. */
export async function readClaudeLoginCredentials(overrides: {
  home?: string;
  readKeychain?: () => Promise<string | null>;
} = {}) {
  const home = overrides.home ?? os.homedir();
  // Custom configuration directories must not silently reuse the default account.
  const directory = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  let content: string | null = null;
  let method = 'credentials_file';
  if (!process.env.CLAUDE_CONFIG_DIR) {
    content = await (overrides.readKeychain ?? readKeychain)();
    if (content) method = 'keychain';
  }
  if (!content) {
    try { content = await readFile(path.join(directory, '.credentials.json'), 'utf8'); }
    catch { return null; }
  }
  let credentials: Record<string, unknown> | null;
  try { credentials = readObjectRecord(JSON.parse(content)); } catch { return null; }
  if (!credentials) return null;
  let email = readOptionalString(credentials.email) ?? readOptionalString(credentials.user) ?? null;
  try {
    const profilePath = process.env.CLAUDE_CONFIG_DIR ? path.join(directory, '.claude.json') : path.join(home, '.claude.json');
    const profile = readObjectRecord(JSON.parse(await readFile(profilePath, 'utf8')));
    email ??= readOptionalString(readObjectRecord(profile?.oauthAccount)?.emailAddress) ?? null;
  } catch { /* The credential can remain usable without cached profile metadata. */ }
  return { credentials, email, method };
}
