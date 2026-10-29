import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { requireOwnedProject, requireUserId } from '@/modules/access/index.js';
import { projectsDb } from '@/modules/database/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    authorizeProject: (request, projectId) => requireOwnedProject(requireUserId(request), projectId),
    ...externalDependencies,
  });
}
