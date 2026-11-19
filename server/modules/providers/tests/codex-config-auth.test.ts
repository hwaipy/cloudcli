import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';

test('Codex recognizes a custom provider bearer token without auth.json and rejects an unconfigured provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(),'codex-config-auth-'));
  const oldHome = process.env.CODEX_HOME; const oldKey = process.env.OPENAI_API_KEY;
  process.env.CODEX_HOME=home; delete process.env.OPENAI_API_KEY;
  try {
    await writeFile(path.join(home,'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nexperimental_bearer_token="fixture-token"\nrequires_openai_auth=false\n');
    const auth = new CodexProviderAuth() as unknown as {checkCredentials:()=>Promise<{authenticated:boolean;method:string|null}>};
    assert.equal((await auth.checkCredentials()).authenticated,true);
    await writeFile(path.join(home,'config.toml'),'model_provider="custom"\n[model_providers.custom]\nrequires_openai_auth=false\n');
    assert.equal((await auth.checkCredentials()).authenticated,false);
  } finally {
    if(oldHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
    if(oldKey===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=oldKey;
    await rm(home,{recursive:true,force:true});
  }
});
