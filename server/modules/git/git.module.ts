import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { requireOwnedProject, requireUserId } from '@/modules/access/index.js';
import { AppError } from '@/shared/utils.js';
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
    resolveProjectPathById: (projectId) => {
      const project = projectsDb.getProjectById(projectId);
      if (project?.strict_file_isolation) throw new AppError('Use the isolated terminal for Git operations in strict projects.', { code: 'ISOLATED_GIT_UI_UNSUPPORTED', statusCode: 409 });
      return project?.project_path ?? null;
    },
    authorizeProject: (request, projectId) => requireOwnedProject(requireUserId(request), projectId),
    ...externalDependencies,
  });
}
