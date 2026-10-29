import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CODEX_PREDEFINED_MODELS, CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

test('Codex fallback catalog excludes models the installed CLI no longer lists', () => {
  assert.deepEqual(CODEX_PREDEFINED_MODELS.OPTIONS.map((option) => option.value), [
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]);
});

test('uses visible models and effort metadata from the Codex CLI cache', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-models-'));
  const cachePath = path.join(dir, 'models_cache.json');
  try {
    await writeFile(cachePath, JSON.stringify({ models: [
      {
        slug: 'gpt-new', display_name: 'GPT New', visibility: 'list',
        description: 'Available to this account', default_reasoning_level: 'high',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      },
      { slug: 'gpt-new', display_name: 'Duplicate', visibility: 'list' },
      { slug: 'internal', display_name: 'Internal', visibility: 'hide' },
      { slug: 'api-disabled', display_name: 'Unavailable', visibility: 'list', supported_in_api: false },
    ] }));

    const catalog = await new CodexProviderModels(cachePath).getSupportedModels();
    assert.equal(catalog.DEFAULT, 'gpt-new');
    assert.deepEqual(catalog.OPTIONS, [{
      value: 'gpt-new', label: 'GPT New', description: 'Available to this account',
      effort: { default: 'high', values: [{ value: 'low' }, { value: 'high' }] },
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('falls back to known CLI models when its cache is absent or malformed', async () => {
  const catalog = await new CodexProviderModels('/missing/cloudcli-models-cache.json').getSupportedModels();
  assert.deepEqual(catalog, CODEX_PREDEFINED_MODELS);
});
