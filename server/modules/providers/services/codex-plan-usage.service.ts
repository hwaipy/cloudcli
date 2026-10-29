import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { readObjectRecord } from '@/shared/utils.js';

type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type PlanUsageBucket = {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType: string | null;
};

type CodexPlanUsage = {
  buckets: PlanUsageBucket[];
  resetCreditsAvailable: number | null;
  fetchedAt: string;
};

type PlanUsageDependencies = {
  readRateLimits: () => Promise<unknown>;
  now: () => number;
};

const CACHE_MS = 60_000;

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readWindow(value: unknown): RateLimitWindow | null {
  const raw = readObjectRecord(value);
  const usedPercent = readFiniteNumber(raw?.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: readFiniteNumber(raw?.windowDurationMins),
    resetsAt: readFiniteNumber(raw?.resetsAt),
  };
}

function normalizeRateLimits(value: unknown, fetchedAt: string): CodexPlanUsage {
  const result = readObjectRecord(value) ?? {};
  const multiBucket = readObjectRecord(result.rateLimitsByLimitId);
  const singleBucket = readObjectRecord(result.rateLimits);
  const entries = multiBucket && Object.keys(multiBucket).length > 0
    ? Object.entries(multiBucket)
    : singleBucket ? [[String(singleBucket.limitId || 'codex'), singleBucket] as const] : [];
  const buckets = entries.flatMap(([key, value]) => {
    const raw = readObjectRecord(value);
    if (!raw) return [];
    const primary = readWindow(raw.primary);
    const secondary = readWindow(raw.secondary);
    if (!primary && !secondary) return [];
    return [{
      limitId: typeof raw.limitId === 'string' && raw.limitId ? raw.limitId : key,
      limitName: typeof raw.limitName === 'string' && raw.limitName ? raw.limitName : null,
      planType: typeof raw.planType === 'string' && raw.planType ? raw.planType : null,
      primary,
      secondary,
      rateLimitReachedType: typeof raw.rateLimitReachedType === 'string' ? raw.rateLimitReachedType : null,
    }];
  });
  const credits = readObjectRecord(result.rateLimitResetCredits);
  return {
    buckets,
    resetCreditsAvailable: readFiniteNumber(credits?.availableCount),
    fetchedAt,
  };
}

/** Used by the providers route to read the host Codex account's reported quota safely. */
export function createCodexPlanUsageService(overrides: Partial<PlanUsageDependencies> = {}) {
  const dependencies: PlanUsageDependencies = {
    readRateLimits: () => codexAppServer.readRateLimits(),
    now: () => Date.now(),
    ...overrides,
  };
  let cached: CodexPlanUsage | null = null;
  let expiresAt = 0;
  let pending: Promise<CodexPlanUsage> | null = null;

  return {
    getCodexPlanUsage(): Promise<CodexPlanUsage> {
      if (cached && dependencies.now() < expiresAt) return Promise.resolve(cached);
      if (pending) return pending;
      pending = dependencies.readRateLimits().then((value) => {
        const checkedAt = dependencies.now();
        cached = normalizeRateLimits(value, new Date(checkedAt).toISOString());
        expiresAt = checkedAt + CACHE_MS;
        return cached;
      }).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

/** Used by provider routes to share a short-lived quota snapshot across requests. */
export const codexPlanUsageService = createCodexPlanUsageService();
