import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProjectSortOrder,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  isActive: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  const sessions = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

const PROJECT_REORDER_GAP_MS = 10 * 60 * 1000;

/** Preserve the displayed order among projects whose send times are close. */
function keepNearbyProjectsStable(
  projects: Project[],
  previousProjectIds: readonly string[],
  activityById: ReadonlyMap<string, number>,
): Project[] {
  const previousIndex = new Map(previousProjectIds.map((id, index) => [id, index]));
  const ordered: Project[] = [];

  // Pinned projects always stay ahead of unpinned projects, regardless of the
  // ten-minute tolerance. Within either group, a project more than ten
  // minutes older than the newest remaining project cannot be chosen next.
  for (const starred of [true, false]) {
    const remaining = projects.filter((project) => Boolean(project.isStarred) === starred);
    while (remaining.length > 0) {
      // `projects` is already sorted by activity within each starred group.
      const newestTime = activityById.get(remaining[0].projectId) ?? 0;
      let nextIndex = 0;
      for (let index = 1; index < remaining.length; index++) {
        const candidate = remaining[index];
        if (newestTime - (activityById.get(candidate.projectId) ?? 0) > PROJECT_REORDER_GAP_MS) continue;
        if ((previousIndex.get(candidate.projectId) ?? Infinity) < (previousIndex.get(remaining[nextIndex].projectId) ?? Infinity)) {
          nextIndex = index;
        }
      }
      ordered.push(remaining.splice(nextIndex, 1)[0]);
    }
  }

  return ordered;
}

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
  previousProjectIds?: readonly string[],
): Project[] => {
  const byName = [...projects];
  const activityById = projectSortOrder === 'date'
    ? new Map(projects.map((project) => [project.projectId, getProjectLastActivity(project).getTime()]))
    : null;

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return (activityById?.get(projectB.projectId) ?? 0) - (activityById?.get(projectA.projectId) ?? 0);
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  if (
    projectSortOrder !== 'date'
    || !activityById
    || !previousProjectIds
    || previousProjectIds.length !== byName.length
    || byName.some((project) => !previousProjectIds.includes(project.projectId))
  ) {
    return byName;
  }

  return keepNearbyProjectsStable(byName, previousProjectIds, activityById);
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/** Display names for the providers a session row can belong to. */
export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
