import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';

type UsageWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type UsageBucket = {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  rateLimitReachedType: string | null;
};

type PlanUsage = {
  buckets: UsageBucket[];
  resetCreditsAvailable: number | null;
  fetchedAt: string;
};

const REFRESH_MS = 60_000;

/** Rendered by AccountContent for Codex account quota, refreshed while the settings page is open. */
export function CodexPlanUsage() {
  const { t, i18n } = useTranslation('chat');
  // Retains the last successful quota snapshot while a later refresh is in flight.
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  // Distinguishes an unavailable quota from the initial loading state.
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.providers.codexPlanUsage();
        const payload = await readApiJson<{ data: PlanUsage }>(response);
        if (active) {
          setUsage(payload.data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const displayDate = (seconds: number | null) => seconds === null
    ? '—'
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000);
  const displayDuration = (minutes: number | null) => {
    if (minutes === null) return null;
    if (minutes % 1440 === 0) return `${minutes / 1440} ${t('usage.days', { defaultValue: 'days' })}`;
    if (minutes % 60 === 0) return `${minutes / 60} ${t('usage.hours', { defaultValue: 'hours' })}`;
    return `${minutes} ${t('usage.minutes', { defaultValue: 'minutes' })}`;
  };

  return (
    <section className="rounded-lg border border-border bg-card/50 p-4" aria-label={t('usage.planQuota', { defaultValue: 'Plan usage' })}>
      <h4 className="mb-3 text-sm font-medium text-foreground">{t('usage.planQuota', { defaultValue: 'Plan usage' })}</h4>
      {usage?.buckets.length ? usage.buckets.map((bucket) => (
        <div key={bucket.limitId} className="border-t border-border/60 py-3 first:border-0 first:pt-0 last:pb-0">
          <div className="text-sm font-medium">{bucket.limitName || bucket.limitId}</div>
          {bucket.planType && <div className="text-xs text-muted-foreground">{t('usage.planType', { defaultValue: 'Plan' })}: {bucket.planType}</div>}
          {([['primary', bucket.primary], ['secondary', bucket.secondary]] as const).map(([key, window]) => window && (
            <div key={key} className="mt-3">
              <div className="flex justify-between gap-2 text-sm">
                <span>{key === 'primary' ? t('usage.primaryWindow', { defaultValue: 'Primary window' }) : t('usage.secondaryWindow', { defaultValue: 'Secondary window' })}{displayDuration(window.windowDurationMins) ? ` · ${displayDuration(window.windowDurationMins)}` : ''}</span>
                <span>{Math.round(window.usedPercent)}%</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{t('usage.resetsAt', { defaultValue: 'Resets' })}: {displayDate(window.resetsAt)}</div>
            </div>
          ))}
          {bucket.rateLimitReachedType && <div className="mt-2 text-sm text-destructive">{t('usage.limitReached', { defaultValue: 'Limit reached' })}</div>}
        </div>
      )) : <p className="text-sm text-muted-foreground">{error || usage ? t('usage.unavailable', { defaultValue: 'Usage unavailable' }) : t('usage.loading', { defaultValue: 'Loading usage…' })}</p>}
      {usage?.resetCreditsAvailable !== null && usage?.resetCreditsAvailable !== undefined && (
        <div className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          {t('usage.resetCredits', { count: usage.resetCreditsAvailable, defaultValue: 'Available resets: {{count}}' })}
        </div>
      )}
      {usage && <div className="mt-2 text-xs text-muted-foreground">{t('usage.checkedAt', { defaultValue: 'Checked' })}: {new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(new Date(usage.fetchedAt))}{error ? ` · ${t('usage.refreshFailed', { defaultValue: 'Refresh failed' })}` : ''}</div>}
    </section>
  );
}
