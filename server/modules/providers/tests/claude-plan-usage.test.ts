import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudePlanUsageService } from '@/modules/providers/services/claude-plan-usage.service.js';

const login = (token = 'fixture-oauth') => ({ credentials: { claudeAiOauth: { accessToken: token, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }, email: 'fixture@example.com', method: 'keychain' });
const quota = { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 37, resets_at: '2026-11-21T02:00:00Z' }, seven_day_opus: null, extra_usage: { is_enabled: false }, unrelated_private_field: 'must-not-leak' };
const response = () => new Response(JSON.stringify(quota));

test('Claude quota preserves zero, normalizes windows and exposes no credentials or unrelated upstream fields', async () => {
  let calls = 0;
  const service = createClaudePlanUsageService({ env: {}, readSettings: async () => ({}), readLogin: async () => login(), now: () => 1000,
    fetch: async (url, options) => { calls++; assert.equal(url, 'https://api.anthropic.com/api/oauth/usage'); assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer fixture-oauth'); return response(); },
  });
  const result = await service.getClaudePlanUsage();
  assert.equal(result.planType, 'max');
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].usedPercent, 0);
  assert.equal(result.windows[1].usedPercent, 37);
  assert.equal(result.extraUsageEnabled, false);
  assert.equal(result.fetchedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(JSON.stringify(result).includes('fixture-oauth'), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  await service.getClaudePlanUsage(); assert.equal(calls, 1);
});

test('Claude quota coalesces concurrent requests and invalidates cache on account change or expiry', async () => {
  let token = 'one'; let clock = 0; let calls = 0;
  let finish!: (response: Response) => void;
  const service = createClaudePlanUsageService({ env: {}, readSettings: async () => ({}), readLogin: async () => login(token), now: () => clock,
    fetch: async () => { calls++; if(calls === 1) return new Promise(resolve => { finish = resolve; }); return response(); },
  });
  const first = service.getClaudePlanUsage(); const second = service.getClaudePlanUsage();
  await new Promise(resolve => setImmediate(resolve)); finish(response());
  await Promise.all([first, second]); assert.equal(calls, 1);
  token = 'two'; await service.getClaudePlanUsage(); assert.equal(calls, 2);
  clock = 61_000; await service.getClaudePlanUsage(); assert.equal(calls, 3);
});

test('Claude quota refuses API keys and third-party endpoints without contacting the official quota API', async () => {
  for (const env of [{ ANTHROPIC_API_KEY: 'fixture-key' }, { ANTHROPIC_AUTH_TOKEN: 'fixture-token' }, { ANTHROPIC_BASE_URL: 'https://example.test' }]) {
    const service = createClaudePlanUsageService({ env, readSettings: async () => ({}), readLogin: async () => login(), fetch: async () => { assert.fail('quota must not be fetched'); } });
    await assert.rejects(service.getClaudePlanUsage(), { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE' });
  }
  const settingsService = createClaudePlanUsageService({ env: {}, readSettings: async () => ({ ANTHROPIC_AUTH_TOKEN: 'fixture-token' }), fetch: async () => { assert.fail('quota must not be fetched'); } });
  await assert.rejects(settingsService.getClaudePlanUsage(), { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE' });
});

test('Claude quota reports missing login and upstream failure without leaking upstream data, and retries after failure', async () => {
  const missing = createClaudePlanUsageService({ env: {}, readSettings: async () => ({}), readLogin: async () => null });
  await assert.rejects(missing.getClaudePlanUsage(), { code: 'CLAUDE_AUTH_REQUIRED' });
  let calls = 0;
  const service = createClaudePlanUsageService({ env: {}, readSettings: async () => ({}), readLogin: async () => login(), fetch: async () => ++calls === 1 ? new Response('private-upstream-data', { status: 401 }) : response() });
  await assert.rejects(service.getClaudePlanUsage(), error => error instanceof Error && !error.message.includes('private-upstream-data'));
  await service.getClaudePlanUsage(); assert.equal(calls, 2);
});

test('an explicit OAuth override never borrows plan metadata from a different saved account', async () => {
  const service = createClaudePlanUsageService({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'override-account' }, readSettings: async () => ({}), readLogin: async () => login(), fetch: async () => response() });
  const result = await service.getClaudePlanUsage();
  assert.equal(result.planType, null);
  assert.equal(result.rateLimitTier, null);
  assert.equal(result.windows[0].usedPercent, 0);
});
