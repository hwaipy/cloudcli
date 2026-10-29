import { memo, useEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, Folder, MoreHorizontal, Plus, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, buttonVariants } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import { getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  /** The sessions ticked in this project's list, or null when it is not the one selecting. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectItemProps) {
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const projectMenuItems = [
    {
      key: 'new-session',
      label: t('sessions.newSession'),
      icon: Plus,
      onSelect: () => onNewSession(project),
    },
    {
      key: 'edit',
      label: t('projects.edit'),
      icon: Edit3,
      onSelect: () => onStartEditingProject(project),
    },
    {
      key: 'favorite',
      label: t(isStarred ? 'tooltips.removeFromFavorites' : 'tooltips.addToFavorites'),
      icon: Star,
      onSelect: toggleStarProject,
    },
    {
      key: 'delete',
      label: t('projects.delete'),
      icon: Trash2,
      isDanger: true,
      showDividerBefore: true,
      onSelect: () => onDeleteProject(project),
    },
  ];

  return (
    <div className={cn(isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        {isCompact && (
        <div>
          <div
            className="relative mx-1 my-0.5 flex h-9 items-center rounded-lg px-2 transition-colors duration-150 hover:bg-accent/60 active:scale-[0.98]"
            onClick={toggleProject}
          >
            <div className="flex w-full min-w-0 items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div className={cn('flex h-5 w-5 shrink-0 items-center justify-center', isStarred ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground')}>
                  <Folder className="h-3 w-3" />
                </div>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      ref={mobileRenameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      className="h-7 w-full rounded-md border border-primary/40 bg-background px-2 text-sm text-foreground focus:border-primary focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          // Cancelling the rename must not also close the code editor.
                          event.stopPropagation();
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <h3 className="truncate text-sm font-normal text-foreground" title={project.fullPath}>{project.displayName}</h3>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    {tasksEnabled && <TaskIndicator status={taskStatus} size="xs" className="shrink-0" />}
                    <span className="text-[11px] tabular-nums text-muted-foreground" aria-label={sessionCountDisplay}>{sessionCountDisplay}</span>
                    <div onClick={(event) => event.stopPropagation()}>
                      <ActionMenu
                        label={t('projects.actions')}
                        ariaLabel={`${project.displayName}: ${t('projects.actions')}`}
                        icon={MoreHorizontal}
                        iconOnly
                        portal
                        variant="ghost"
                        size="icon"
                        triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted"
                        menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
                        items={projectMenuItems}
                      />
                    </div>

                    <div className="flex h-6 w-6 items-center justify-center text-muted-foreground">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {!isCompact && (
        <div className="group relative">
        <div
          role="button"
          tabIndex={0}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'h-9 w-full cursor-pointer justify-start rounded-lg bg-transparent px-2 py-1 pr-11 text-left font-normal transition-colors duration-150 hover:bg-accent/60',
          )}
          onClick={toggleProject}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              toggleProject();
            }
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                isStarred
                  ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-muted-foreground',
              )}
            >
              <Folder className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div>
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    className="h-7 w-full rounded border border-border bg-background px-2 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        // Cancelling the rename must not also close the code editor.
                        event.stopPropagation();
                        onCancelEditingProject();
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="truncate text-sm font-normal text-foreground" title={project.fullPath}>
                  {project.displayName}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {!isEditing && <span className="text-[11px] tabular-nums text-muted-foreground" aria-label={sessionCountDisplay}>{sessionCountDisplay}</span>}
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </>
            )}
          </div>
        </div>
        {!isEditing && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <ActionMenu
              label={t('projects.actions')}
              ariaLabel={`${project.displayName}: ${t('projects.actions')}`}
              icon={MoreHorizontal}
              iconOnly
              portal
              variant="ghost"
              size="icon"
              triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
              menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
              items={projectMenuItems}
            />
          </div>
        )}
        </div>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        backgroundSessionIds={backgroundSessionIds}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        selectedSessionIds={selectedSessionIds}
        onSetSessionSelection={onSetSessionSelection}
        onToggleSessionSelected={onToggleSessionSelected}
        onCancelSessionSelection={onCancelSessionSelection}
        onDeleteSelectedSessions={onDeleteSelectedSessions}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
