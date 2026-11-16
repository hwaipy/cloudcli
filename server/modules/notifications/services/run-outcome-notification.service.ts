import { randomUUID } from 'node:crypto';

import type { AnyRecord } from '@/shared/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';

type RunOutcome = {
  userId: string | number | null;
  provider: string;
  sessionId?: string | null;
  runId?: string | null;
  outcome: 'completed' | 'failed';
  error?: unknown;
};
// Legacy JavaScript inference narrows optional session/dedupe fields to null.
const notificationEvent = createNotificationEvent as (input: AnyRecord) => unknown;

/** Codex App Server reports each turn through this API so fast consecutive turns never share a dedupe key. */
export function notifyRunOutcome({ userId, provider, sessionId = null, runId, outcome, error }: RunOutcome): void {
  if (!userId) return;
  const failed = outcome === 'failed';
  const message = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message
      : error == null ? 'Unknown error' : String(error);
  const code = failed ? 'run.failed' : 'run.stopped';
  notifyUserIfEnabled({ userId, event: notificationEvent({
    provider, sessionId, kind: failed ? 'error' : 'stop', code,
    meta: failed ? { error: message } : { stopReason: 'completed' }, severity: failed ? 'error' : 'info',
    // Native turn IDs collapse repeated completion callbacks for the same turn.
    // Startup failures have no native ID yet, but are distinct failed submissions.
    dedupeKey: `${userId}:${provider}:${sessionId || 'none'}:${runId || randomUUID()}:${code}`,
  }) });
}
