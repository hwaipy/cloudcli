import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexPlanUsageService } from '@/modules/providers/services/codex-plan-usage.service.js';

test('Codex plan usage keeps separate quota buckets and caches a successful read', async () => {
  let now = Date.UTC(2026, 9, 29);
  let calls = 0;
  const service = createCodexPlanUsageService({
    now: () => now,
    readRateLimits: async () => {
      calls += 1;
      return {
        accountId: 'private-account-id',
        rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex', planType: 'prolite',
            primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1793774154 },
            secondary: null,
          },
          other: {
            limitId: 'other', limitName: 'Other quota',
            primary: { usedPercent: 120, windowDurationMins: 60, resetsAt: null },
          },
        },
        rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'private-credit-id' }] },
      };
    },
  });

  const first = await service.getCodexPlanUsage();
  const second = await service.getCodexPlanUsage();
  assert.equal(calls, 1);
  assert.strictEqual(second, first);
  assert.deepEqual(first.buckets.map((bucket) => [bucket.limitId, bucket.primary?.usedPercent]), [
    ['codex', 24], ['other', 100],
  ]);
  assert.equal(first.buckets[0]?.planType, 'prolite');
  assert.equal(first.buckets[0]?.primary?.windowDurationMins, 10080);
  assert.equal(first.resetCreditsAvailable, 2);
  assert.equal(JSON.stringify(first).includes('private-'), false);

  now += 60_001;
  await service.getCodexPlanUsage();
  assert.equal(calls, 2);
});

test('Codex plan usage coalesces concurrent reads and retries after a failure', async () => {
  let calls = 0;
  const service = createCodexPlanUsageService({
    readRateLimits: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return { rateLimits: { limitId: 'codex', primary: { usedPercent: 42 } } };
    },
  });

  await assert.rejects(service.getCodexPlanUsage(), /temporary failure/);
  const [first, second] = await Promise.all([service.getCodexPlanUsage(), service.getCodexPlanUsage()]);
  assert.equal(calls, 2);
  assert.strictEqual(first, second);
  assert.equal(first.buckets[0]?.primary?.usedPercent, 42);
});
