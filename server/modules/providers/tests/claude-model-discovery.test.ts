import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';

const rows = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', description: 'Opus 5.5 · Recommended', supportsEffort: true, supportedEffortLevels: ['low','high','xhigh','max'] },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5', description: 'Sonnet 5.5 · Efficient', supportsEffort: true, supportedEffortLevels: ['medium','high'] },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5', supportsEffort: false },
];

test('Claude uses CLI-reported versions for labels while preserving native wire aliases', async () => {
  const models = await new ClaudeProviderModels(async () => rows).getSupportedModels();
  assert.deepEqual(models.OPTIONS.map(row => [row.value,row.label]), [['default','Default (recommended) · Opus 5.5'],['sonnet','Sonnet 5.5'],['haiku','Haiku 5.5']]);
  assert.equal(models.DEFAULT,'default');
  assert.equal(models.OPTIONS.some(row => row.value === 'opusplan'), false);
  assert.equal(models.OPTIONS[0].effort?.values.some(level => level.value === 'ultracode'),true);
  assert.deepEqual(models.OPTIONS[1].effort?.values.map(level => level.value),['medium','high']);
  assert.equal(models.OPTIONS[2].effort,undefined);
});

test('Claude retains context suffixes, deduplicates native options and does not invent a version from a date', async () => {
  const models = await new ClaudeProviderModels(async () => [
    { value: 'sonnet[1m]', displayName: 'Sonnet (1M context)', description:'Sonnet 5.5 · Long context' },
    { value: 'sonnet[1m]', displayName:'Duplicate' },
    { value: 'custom', displayName:'Custom endpoint', resolvedModel:'claude-sonnet-4-20250514' },
    {}, null,
  ]).getSupportedModels();
  assert.equal(models.OPTIONS[0].label,'Sonnet 5.5 (1M context)');
  assert.equal(models.OPTIONS[1].label,'Custom endpoint');
  assert.equal(models.OPTIONS.length,2);
});

test('Claude model discovery coalesces requests, expires its cache and retries a failure without static guesses', async () => {
  let calls = 0; let clock = 0; let finish!: (rows: unknown) => void;
  const provider = new ClaudeProviderModels(async () => {
    calls++;
    if(calls === 1) return new Promise(resolve => { finish = resolve; });
    if(calls === 2) throw Error('CLI unavailable');
    return rows;
  }, () => clock);
  const one = provider.getSupportedModels();const two = provider.getSupportedModels();
  finish(rows); await Promise.all([one,two]); assert.equal(calls,1);
  await provider.getSupportedModels(); assert.equal(calls,1);
  clock = 61_000; await assert.rejects(provider.getSupportedModels(),/CLI unavailable/);
  await provider.getSupportedModels(); assert.equal(calls,3);
});

test('Claude reports invalid or empty native catalogs as unavailable', async () => {
  for(const response of [null,{},[],[{ value:'' }]]) {
    await assert.rejects(new ClaudeProviderModels(async () => response).getSupportedModels());
  }
});
