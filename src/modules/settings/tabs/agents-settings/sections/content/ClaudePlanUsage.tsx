import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { formatDateTime24 } from '@/shared/utils';

type ClaudeUsage = {
  planType: string | null;
  rateLimitTier: string | null;
  windows: { key: string; label: string; usedPercent: number; resetsAt: string | null }[];
  extraUsageEnabled: boolean;
  fetchedAt: string;
};

/** BackendPlanUsageTab uses this panel for one explicitly routed backend’s official Claude quota. */
export function ClaudePlanUsage({ backendId }: { backendId: string }) {
  const { t, i18n } = useTranslation('chat');
  // Keep the last good snapshot visible when a subsequent request fails.
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  // An unavailable account must not be displayed as zero percent usage.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setUsage(null);
    setError(null);
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const payload = await readApiJson<{ data: ClaudeUsage }>(await api.providers.claudePlanUsage(backendId));
        if (active) { setUsage(payload.data); setError(null); }
      } catch {
        if (active) setError(t('usage.unavailable', { defaultValue: 'Usage unavailable' }));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 60_000);
      }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [backendId, t]);
  const plan = usage?.planType === 'max'
    ? `Max${usage.rateLimitTier?.includes('20x') ? ' 20×' : usage.rateLimitTier?.includes('5x') ? ' 5×' : ''}`
    : usage?.planType;
  return (
    <section className="rounded-lg border border-border bg-card/50 p-4" aria-label="Claude plan usage">
      <h4 className="mb-3 text-sm font-medium">Claude · {t('usage.planQuota', { defaultValue: 'Plan usage' })}{plan ? ` · ${plan}` : ''}</h4>
      {!usage && <p role={error ? 'status' : undefined} className="text-sm text-muted-foreground">{error ?? t('usage.loading', { defaultValue: 'Loading usage…' })}</p>}
      {usage?.windows.map((window) => (
        <div key={window.key} className="mb-3">
          <div className="flex justify-between gap-2 text-sm"><span>{window.key === 'five_hour' ? `5 ${t('usage.hours', { defaultValue: 'hours' })}` : window.key === 'seven_day' ? `7 ${t('usage.days', { defaultValue: 'days' })}` : window.label}</span><span>{Math.round(window.usedPercent)}%</span></div>
          <div role="progressbar" aria-label={window.label} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${window.usedPercent}%` }} />
          </div>
          {window.resetsAt && <div className="mt-1 text-xs text-muted-foreground">{t('usage.resetsAt', { defaultValue: 'Resets' })}: {formatDateTime24(window.resetsAt, { dateStyle: 'medium', timeStyle: 'short' }, i18n.language)}</div>}
        </div>
      ))}
      {usage && <p className="text-xs text-muted-foreground">{t('usage.checkedAt', { defaultValue: 'Checked' })}: {formatDateTime24(usage.fetchedAt, { timeStyle: 'short' }, i18n.language)}{error ? ` · ${t('usage.refreshFailed', { defaultValue: 'Refresh failed' })}` : ''}</p>}
    </section>
  );
}
