import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Shimmer } from '@/shared/ui';
import type { BackgroundTaskSummary, SessionActivity } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];
const EXIT_ANIMATION_MS = 220;

/** What the background work is: the one task by kind and name, or how many when there are several. */
function describeBackgroundTasks(allTasks: BackgroundTaskSummary[], t: TFunction): string {
  const tasks = ownBackgroundTasks(allTasks);
  return tasks.length === 1
    ? describeBackgroundTask(tasks[0], t)
    : t('claudeStatus.backgroundTask.count', { count: tasks.length, defaultValue: '{{count}} tasks' });
}

/**
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time. Rendered only while the viewed
 * session has an entry in the processing map; it disappears the instant that
 * entry is removed.
 *
 * A session whose turn has ended while the tasks it launched still run is
 * drawn in the workflow and agent cards' purple, naming the work.
 *
 * Rendered by ChatMessagesPane after the newest transcript row. The composer
 * owns the single Stop button while a turn is in flight.
 */
export default function ActivityIndicator({ activity }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  const isBackground = Boolean(renderedActivity.background);
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const label = isBackground
    ? t('claudeStatus.backgroundWork', 'Background work')
    : (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
      .replace(/\.+$/, '');
  const detail = isBackground ? describeBackgroundTasks(renderedActivity.tasks ?? [], t) : '';

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  return (
    <div
      className={`px-3 sm:px-0 ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
        <span
          className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
            isBackground ? 'bg-purple-500 dark:bg-purple-400' : 'bg-primary'
          }`}
          aria-hidden
        />
        <Shimmer className="shrink-0 font-medium">{`${label}…`}</Shimmer>
        {detail && (
          <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span>
        )}
        <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
      </div>
    </div>
  );
}
