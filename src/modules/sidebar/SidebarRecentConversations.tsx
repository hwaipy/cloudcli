import { Loader2, MessageSquare } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { Button, LLMProviderLogo, Tooltip, useAppContextMenu } from '@/shared/ui';
import { cn, copyTextToClipboard, getSessionPageUrl } from '@/shared/utils';
import type { ProjectSession, RecentConversationListItem, SessionRowActions } from '@/shared/types';
import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarRecentConversationsProps = {
  conversations: RecentConversationListItem[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  /**
   * The same row state and callbacks the Projects list hands its rows, so a
   * conversation can be renamed, copied, forked or archived from here too.
   */
  sessionActions: SessionRowActions;
  onConversationSelect: (
    projectId: string | null,
    sessionId: string,
    provider: string,
  ) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  t: TFunction;
};

function RecentConversationSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-label="Loading recent conversations">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-2.5">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${72 - index * 3}%` }} />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rendered by SidebarContent in the recents search mode to list recently active sessions across all projects. */
export default function SidebarRecentConversations({
  conversations,
  total,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  selectedSession,
  currentTime,
  sessionActions,
  onConversationSelect,
  onLoadMore,
  onRetry,
  t,
}: SidebarRecentConversationsProps) {
  const openContextMenu = useAppContextMenu();
  const forkableProviders = useSessionForkingProviders();
  if (isLoading && conversations.length === 0) {
    return <RecentConversationSkeleton />;
  }

  if (hasError && conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.loadFailed', 'Could not load recent conversations')}
        </p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.emptyTitle', 'No conversations yet')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('recent.emptyDescription', 'Your most recently updated conversations will appear here.')}
        </p>
      </div>
    );
  }

  return (
    <div className="px-1" data-testid="recent-conversations-list">
      <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('recent.title', 'Recent conversations')}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{total}</span>
      </div>

      <div className="space-y-0.5">
        {conversations.map((conversation) => {
          const isSelected = String(selectedSession?.id ?? '') === conversation.sessionId;
          const age = formatCompactAge(conversation.lastActivity, currentTime);
          const hasBackgroundWork = sessionActions.backgroundSessionIds.has(conversation.sessionId);
          const isProcessing = sessionActions.activeSessions.has(conversation.sessionId) && !hasBackgroundWork;
          // Resolved per row so a keystroke in one rename does not redraw the rest.
          const rename = sessionActions.activeRename;
          const sessionRename =
            rename?.target === 'session' && rename.id === conversation.sessionId ? rename : null;

          const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            onConversationSelect(
              conversation.projectId,
              conversation.sessionId,
              conversation.provider,
            );
          };

          return (
            <div key={conversation.sessionId} className="group relative" onContextMenu={(event) => openContextMenu(event, [
              { key: 'open', label: '打开会话', onSelect: () => onConversationSelect(conversation.projectId, conversation.sessionId, conversation.provider) },
              ...(conversation.projectId ? [{ key: 'rename', label: '重命名会话', onSelect: () => sessionActions.onStartEditingSession(conversation.projectId!, conversation.sessionId, conversation.sessionTitle) }] : []),
              { key: 'copy-title', label: '复制会话名称', onSelect: async () => { if (!await copyTextToClipboard(conversation.sessionTitle)) throw new Error('复制失败'); } },
              { key: 'copy-link', label: '复制会话链接', onSelect: async () => { if (!await copyTextToClipboard(getSessionPageUrl(conversation.sessionId))) throw new Error('复制失败'); } },
              ...(sessionActions.onForkSession && forkableProviders.has(conversation.provider) ? [{ key: 'fork', label: '分叉会话', disabled: isProcessing, onSelect: () => sessionActions.onForkSession?.({ id: conversation.sessionId, __provider: conversation.provider, projectId: conversation.projectId ?? undefined }) }] : []),
              { key: 'delete', label: '归档或删除会话…', disabled: isProcessing, isDanger: true, showDividerBefore: true, onSelect: () => sessionActions.onDeleteSession(conversation.sessionId, conversation.sessionTitle) },
            ])}>
              <a
                href={getSessionPageUrl(conversation.sessionId)}
                onClick={handleClick}
                data-testid="recent-conversation-row"
                className={cn(
                  'flex h-[1.8rem] min-w-0 items-center gap-2 rounded-lg bg-transparent px-2 py-1 pr-11 text-left transition-colors',
                  isSelected
                    ? 'bg-accent/80 text-foreground'
                    : 'text-foreground hover:bg-accent/60',
                )}
              >
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                  <LLMProviderLogo provider={conversation.provider} className="h-3 w-3" />
                </span>

                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-normal" title={`${conversation.sessionTitle} · ${conversation.projectDisplayName}`}>
                    {conversation.sessionTitle}
                  </span>
                  <span className="flex shrink-0 items-center text-[10px] text-muted-foreground">
                    {isProcessing ? (
                        <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                        </Tooltip>
                    ) : hasBackgroundWork ? (
                      // No spinner: nothing is responding. The purple of the
                      // workflow and agent cards says what is still running.
                        <Tooltip content={t('tooltips.backgroundWorkIndicator', 'Background work running')} position="top">
                          <span
                            role="status"
                            aria-label={t('tooltips.backgroundWorkIndicator', 'Background work running')}
                            className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400"
                          />
                        </Tooltip>
                    ) : age && (
                        <time className="flex-shrink-0 tabular-nums" dateTime={conversation.lastActivity ?? undefined}>
                          {age}
                        </time>
                    )}
                  </span>
                </span>
              </a>

              <SessionOptions
                className="absolute right-2 top-1/2 -translate-y-1/2 transform"
                sessionId={conversation.sessionId}
                sessionName={conversation.sessionTitle}
                provider={conversation.provider}
                projectId={conversation.projectId}
                isProcessing={isProcessing}
                isEditing={sessionRename !== null}
                renameDraft={sessionRename?.draft ?? ''}
                onRenameDraftChange={sessionActions.onRenameDraftChange}
                onStartEditingSession={sessionActions.onStartEditingSession}
                onCancelEditingSession={sessionActions.onCancelEditingSession}
                onSaveEditingSession={sessionActions.onSaveEditingSession}
                onDeleteSession={sessionActions.onDeleteSession}
                // The fork path reads only the id, provider and owning project,
                // which is all a recents row knows about the session.
                onFork={sessionActions.onForkSession
                  ? () => sessionActions.onForkSession?.({
                    id: conversation.sessionId,
                    summary: conversation.sessionTitle,
                    __provider: conversation.provider,
                    __projectId: conversation.projectId ?? undefined,
                  })
                  : undefined}
                t={t}
              />
            </div>
          );
        })}
      </div>

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full text-xs text-muted-foreground"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore
            ? t('recent.loadingMore', 'Loading more...')
            : t('recent.loadMore', 'Load older conversations')}
        </Button>
      )}
    </div>
  );
}
