import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeLoginCredentials } from '@/modules/providers/services/claude-login-credentials.service.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';

const oauth = { claudeAiOauth: { accessToken: 'fixture-oauth', expiresAt: Date.now() + 600_000, subscriptionType: 'max' } };

test('Mac keychain-only Claude login is recognized with cached email and no token in auth status', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-keychain-'));
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;
  const saved = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  const oldHome = process.env.HOME; process.env.HOME = home;
  try {
    await writeFile(path.join(home,'.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fixture@example.com' } }));
    const auth = new ClaudeProviderAuth(() => readClaudeLoginCredentials({ home, readKeychain: async () => JSON.stringify(oauth) }));
    auth.checkInstalled = () => ({ installed: true, exitCode: 0, version: '2.1.312' });
    const status = await auth.getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'keychain');
    assert.equal(status.email, 'fixture@example.com');
    assert.equal(JSON.stringify(status).includes('fixture-oauth'), false);
    await mkdir(path.join(home,'.claude'));
    await writeFile(path.join(home,'.claude/.credentials.json'), JSON.stringify({ ...oauth, email: 'file@example.com' }));
    const fallback = await readClaudeLoginCredentials({ home, readKeychain: async () => null });
    assert.equal(fallback?.method, 'credentials_file');
    assert.equal(fallback?.email, 'file@example.com');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    keys.forEach((key,index) => { if(saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    await rm(home,{recursive:true,force:true});
  }
});
