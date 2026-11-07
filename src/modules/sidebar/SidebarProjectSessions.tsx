import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  /** The sessions ticked here, or null when this project's list is not in selection mode. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

// The half-visible row and its trigger derive from the same preview size.
const PREVIEW_SESSION_COUNT = 3;

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex h-[1.8rem] items-center gap-2 rounded-lg px-2">
          <div className="h-3 w-3 animate-pulse rounded-full bg-muted" />
          <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  backgroundSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  // A large project's first opening is a preview; only an explicit click reveals all rows.
  const [fullyExpanded, setFullyExpanded] = useState(false);
  // Attempt each page once automatically, avoiding a retry loop on a failed page.
  const lastAutoLoadCount = useRef<number | null>(null);
  const hasPreview = sessions.length > PREVIEW_SESSION_COUNT || (sessions.length > 0 && hasMoreSessions);
  const isPreview = hasPreview && !fullyExpanded && selectedSessionIds === null;
  useEffect(() => {
    if (!isExpanded || !initialSessionsLoaded || !hasMoreSessions || isLoadingMoreSessions || sessions.length === 0) return;
    if (!fullyExpanded && sessions.length >= PREVIEW_SESSION_COUNT + 1) return;
    if (lastAutoLoadCount.current === sessions.length) return;
    lastAutoLoadCount.current = sessions.length;
    onLoadMoreSessions(project.projectId);
  }, [isExpanded, initialSessionsLoaded, hasMoreSessions, isLoadingMoreSessions, fullyExpanded, sessions.length, onLoadMoreSessions, project.projectId]);

  useEffect(() => {
    if (isExpanded) return;
    // Reset the preview after the closing transition, without shrinking its contents mid-animation.
    const timer = window.setTimeout(() => setFullyExpanded(false), 300);
    return () => window.clearTimeout(timer);
  }, [isExpanded]);

  const hasSessions = sessions.length > 0;
  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  const selectableSessionIds = sessions.filter((session) => !isSessionRunning(session)).map((session) => session.id);
  // Re-derived from the selectable rows rather than read straight off the
  // selection, so a row that started running after it was ticked drops out of
  // the count, the button and the ids the confirmation is opened with.
  const effectiveSelectedIds = selectedSessionIds
    ? selectableSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
    : [];
  const checkedSessionIds = new Set(effectiveSelectedIds);
  const allLoadedSelected =
    selectableSessionIds.length > 0 && effectiveSelectedIds.length === selectableSessionIds.length;
  // With more sessions on the server than on screen, the button only reaches the
  // loaded rows, so it offers "Select all loaded" rather than a "Select all" it
  // could not honour. Once those rows are ticked it flips to "Clear" either way.
  const selectAllLabel = allLoadedSelected
    ? t('sessions.clearSelection')
    : hasMoreSessions
      ? t('sessions.selectAllLoaded')
      : t('sessions.selectAll');

  return (
    <div data-project-session-transition aria-hidden={!isExpanded} {...(!isExpanded ? { inert: '' } : {})}
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none"
      style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr', opacity: isExpanded ? 1 : 0 }}>
    <div className="min-h-0 overflow-hidden">
    <div className="group/project-sessions relative ml-3 space-y-0.5 border-l border-border/60 pl-2">
      {isSelecting && (
        <div className={cn('space-y-1', isCompact && 'px-3')}>
          {/* Wraps rather than clips: at the narrowest sidebar width a long
              translated "Select all loaded" leaves no room for Cancel. */}
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                onSetSessionSelection({
                  projectId: project.projectId,
                  sessionIds: new Set(allLoadedSelected ? [] : selectableSessionIds),
                })
              }
              disabled={selectableSessionIds.length === 0}
            >
              {selectAllLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onCancelSessionSelection}
            >
              {t('actions.cancel')}
            </Button>
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 w-full justify-center gap-2 bg-red-600 text-xs font-medium text-white hover:bg-red-700"
            onClick={() => onDeleteSelectedSessions(effectiveSelectedIds)}
            disabled={effectiveSelectedIds.length === 0}
          >
            <Trash2 className="h-3 w-3" />
            {t('sessions.deleteSelected', { count: effectiveSelectedIds.length })}
          </Button>
        </div>
      )}

      {/* A page emptied by deleting every loaded row still has sessions behind
          it on the server, so it keeps its "Load more" instead of "No sessions". */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !hasMoreSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          <div data-session-expansion={isPreview ? 'preview' : 'full'}
            className="-ml-2 grid min-w-0 grid-cols-1 auto-rows-[2rem] gap-[0.1rem] overflow-hidden pl-2 transition-[max-height] duration-300 ease-in-out motion-reduce:transition-none"
            style={isPreview ? { maxHeight: `calc(${PREVIEW_SESSION_COUNT + 0.5} * 2.1rem)`, maskImage: 'linear-gradient(to bottom, black calc(100% - 1.6rem), transparent 100%)' } : { maxHeight: `${sessions.length * 2.1}rem` }}>
          {(isPreview ? sessions.slice(0, PREVIEW_SESSION_COUNT + 1) : sessions).map((session, index) => (
            <div key={session.id} className="min-w-0" {...(isPreview && index === PREVIEW_SESSION_COUNT ? { inert: '' } : {})}>

            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={isSessionRunning(session)}
              hasBackgroundWork={backgroundSessionIds.has(session.id)}
              currentTime={currentTime}
              onRenameDraftChange={onRenameDraftChange}
              isEditing={session.id === sessionRenameId}
              renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              isSelecting={isSelecting}
              isChecked={checkedSessionIds.has(session.id)}
              onToggleSessionSelected={onToggleSessionSelected}
              t={t}
            />
            </div>
          ))}
          </div>
          {isPreview && !isSelecting && <button type="button" data-preview-expand-zone
            aria-label="展开全部会话" aria-expanded={false}
            onClick={() => setFullyExpanded(true)}
            className="absolute bottom-0 left-3 right-1 z-20 h-[1.05rem] rounded-lg bg-transparent transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />}

          {hasMoreSessions && !isPreview && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
    </div>
    </div>
  );
}
