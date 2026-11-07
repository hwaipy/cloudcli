import type { Project } from '@/shared/types';

export type ProjectSelectionMetadata = Pick<
  Project,
  'projectId' | 'displayName' | 'fullPath' | 'path' | 'isStarred' | 'taskmaster'
  | 'strictFileIsolation' | '__hubBackendId' | '__hubBackendName' | '__hubBackendColor'
>;

const valuesMatch = (left: unknown, right: unknown): boolean => (
  Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
);

/**
 * Keep the project object consumed by the main workspace independent from the
 * sidebar's paginated session list. Session-only updates stay in `projects`;
 * this selected value changes only when workspace metadata changes.
 */
export function mergeProjectSelectionMetadata(
  current: Project,
  incoming: ProjectSelectionMetadata,
): Project {
  if (current.projectId !== incoming.projectId) {
    return current;
  }

  const nextPath = incoming.path ?? current.path;
  const nextIsStarred = incoming.isStarred ?? current.isStarred;
  const nextTaskmaster = incoming.taskmaster ?? current.taskmaster;

  const nextBackendId = incoming.__hubBackendId ?? current.__hubBackendId;
  const nextBackendName = incoming.__hubBackendName ?? current.__hubBackendName;
  const nextBackendColor = incoming.__hubBackendColor ?? current.__hubBackendColor;

  const nextStrictIsolation = incoming.strictFileIsolation ?? current.strictFileIsolation;
  if (
    current.strictFileIsolation === nextStrictIsolation
    && current.__hubBackendId === nextBackendId
    && current.__hubBackendName === nextBackendName
    && current.__hubBackendColor === nextBackendColor
    && current.displayName === incoming.displayName
    && current.fullPath === incoming.fullPath
    && current.path === nextPath
    && current.isStarred === nextIsStarred
    && valuesMatch(current.taskmaster, nextTaskmaster)
  ) {
    return current;
  }

  return {
    ...current,
    strictFileIsolation: nextStrictIsolation,
    __hubBackendId: nextBackendId,
    __hubBackendName: nextBackendName,
    __hubBackendColor: nextBackendColor,
    displayName: incoming.displayName,
    fullPath: incoming.fullPath,
    path: nextPath,
    isStarred: nextIsStarred,
    taskmaster: nextTaskmaster,
  };
}
