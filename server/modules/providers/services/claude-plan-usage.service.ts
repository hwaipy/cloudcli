import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readClaudeLoginCredentials } from '@/modules/providers/services/claude-login-credentials.service.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Used by the providers quota route; reads only official OAuth quota, never API-key billing. */
export function createClaudePlanUsageService(overrides: {
  readLogin?: typeof readClaudeLoginCredentials;
  readSettings?: () => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const readLogin = overrides.readLogin ?? readClaudeLoginCredentials;
  const env = overrides.env ?? process.env;
  const request = overrides.fetch ?? fetch;
  const now = overrides.now ?? Date.now;
  const readSettings = overrides.readSettings ?? (async () => {
    try {
      const dir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      const settings = readObjectRecord(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')));
      return readObjectRecord(settings?.env) ?? {};
    } catch { return {}; }
  });
  type Snapshot = {
    planType: string | null;
    rateLimitTier: string | null;
    windows: { key: string; label: string; usedPercent: number; resetsAt: string | null }[];
    extraUsageEnabled: boolean;
    fetchedAt: string;
  };
  let cached: { token: string; value: Snapshot; expires: number } | null = null;
  let pending: { token: string; request: Promise<Snapshot> } | null = null;

  return {
    async getClaudePlanUsage(): Promise<Snapshot> {
      const settings = await readSettings();
      const baseUrl = env.ANTHROPIC_BASE_URL ?? settings.ANTHROPIC_BASE_URL;
      if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || settings.ANTHROPIC_AUTH_TOKEN || settings.ANTHROPIC_API_KEY
        || (baseUrl && String(baseUrl).replace(/\/$/, '') !== 'https://api.anthropic.com')) {
        throw new AppError('Claude subscription usage is unavailable while API credentials or a custom endpoint are configured.', { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE', statusCode: 409 });
      }
      const login = await readLogin();
      const oauth = readObjectRecord(login?.credentials.claudeAiOauth);
      const overrideToken = readOptionalString(env.CLAUDE_CODE_OAUTH_TOKEN) ?? readOptionalString(settings.CLAUDE_CODE_OAUTH_TOKEN);
      const token = overrideToken ?? readOptionalString(oauth?.accessToken);
      if (!token) throw new AppError('Sign in to Claude Code on this backend to view subscription usage.', { code: 'CLAUDE_AUTH_REQUIRED', statusCode: 409 });
      if (cached?.token === token && cached.expires > now()) return cached.value;
      if (pending?.token === token) return pending.request;
      const task = (async () => {
        let response: Response;
        try {
          response = await request('https://api.anthropic.com/api/oauth/usage', {
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
            signal: AbortSignal.timeout(15_000),
          });
        } catch { throw new AppError('Could not fetch Claude subscription usage.', { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE', statusCode: 502 }); }
        if (!response.ok) throw new AppError(response.status === 401 ? 'Claude login expired; sign in again on this backend.' : 'Claude subscription usage is temporarily unavailable.', { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE', statusCode: 502 });
        let raw: Record<string, unknown> | null;
        try { raw = readObjectRecord(await response.json()); } catch { raw = null; }
        if (!raw) throw new AppError('Claude returned an invalid usage response.', { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE', statusCode: 502 });
        const labels: Record<string, string> = { five_hour: '5 hours', seven_day: '7 days', seven_day_opus: 'Opus · 7 days', seven_day_sonnet: 'Sonnet · 7 days' };
        const windows: Snapshot['windows'] = [];
        for (const [key, label] of Object.entries(labels)) {
          const window = readObjectRecord(raw[key]);
          if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) continue;
          windows.push({ key, label, usedPercent: Math.max(0, Math.min(100, window.utilization)), resetsAt: readOptionalString(window.resets_at) ?? null });
        }
        if (!windows.length) throw new AppError('Claude did not report subscription usage windows.', { code: 'CLAUDE_PLAN_USAGE_UNAVAILABLE', statusCode: 502 });
        const snapshot = {
          planType: overrideToken ? null : readOptionalString(oauth?.subscriptionType) ?? null,
          rateLimitTier: overrideToken ? null : readOptionalString(oauth?.rateLimitTier) ?? null,
          windows,
          extraUsageEnabled: readObjectRecord(raw.extra_usage)?.is_enabled === true,
          fetchedAt: new Date(now()).toISOString(),
        };
        cached = { token, value: snapshot, expires: now() + 60_000 };
        return snapshot;
      })();
      const entry = { token, request: task };
      pending = entry;
      try { return await task; } finally { if (pending === entry) pending = null; }
    },
  };
}

/** Singleton used by the authenticated provider routes, with a one-minute account-scoped cache. */
export const claudePlanUsageService = createClaudePlanUsageService();
