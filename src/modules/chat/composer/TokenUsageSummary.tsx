import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/shared/ui';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
  part?: 'context' | 'total' | 'both';
};

const formatTokenCount = (value: number, precise = false) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(precise ? 3 : value >= 10_000_000 ? 0 : 1);
    return `${precise ? millions.replace(/\.?0+$/, '') : millions}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rendered by ChatComposer to show session tokens and context occupancy as
 * separate controls that open the detailed token breakdown on click.
 */
function TokenUsageSummary({ usage, onClick, part = 'both' }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const contextKnown = usage !== null && usage.contextUsed !== null;
  const usedTokens = contextKnown ? readUsageNumber(usage?.used) || inputTokens + outputTokens : 0;
  const contextWindow = readUsageNumber(usage?.total);
  const sessionTotal = usage?.sessionTotalTokens === undefined
    ? null
    : readUsageNumber(usage.sessionTotalTokens);
  const contextPercentage = contextKnown && contextWindow > 0
    ? Math.min(100, Math.max(0, usedTokens / contextWindow * 100))
    : null;
  const sessionTotalLabel = `${t('chat:usage.sessionTotal', 'Session total')}: ${sessionTotal === null ? '—' : sessionTotal.toLocaleString()} ${t('chat:misc.tokensLabel', { count: sessionTotal ?? 0 })}`;
  const contextLabel = `${t('chat:usage.context', 'Context')}: ${contextKnown ? formatTokenCount(usedTokens) : '—'} / ${contextWindow > 0 ? formatTokenCount(contextWindow) : '—'}${contextPercentage !== null ? ` · ${Math.round(contextPercentage)}%` : ''}`;

  return (
    <>
      {part !== 'total' && <Tooltip content={contextLabel}>
        <button
          type="button"
          onClick={onClick}
          className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/70 text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label={contextLabel}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted-foreground/20" />
            {contextPercentage !== null && (
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-primary" strokeDasharray={`${contextPercentage * 0.56549} 56.549`} />
            )}
          </svg>
        </button>
      </Tooltip>}
      {part !== 'context' && <button
        type="button"
        onClick={onClick}
        className="inline-flex h-9 shrink-0 items-center rounded-lg border border-border/70 bg-background/70 px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        title={sessionTotalLabel}
        aria-label={sessionTotalLabel}
      >
        {sessionTotal === null ? '—' : formatTokenCount(sessionTotal, true)}
      </button>}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke while usage updates arrive independently. */
export default memo(TokenUsageSummary);
