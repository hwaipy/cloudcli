import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';

import { requireOwnedProject, requireUserId } from '@/modules/access/index.js';
import { AppError } from '@/shared/utils.js';
import { projectsDb } from '@/modules/database/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  resolveProjectPathById: (projectId) => {
    const project = projectsDb.getProjectById(projectId);
    if (project?.strict_file_isolation) throw new AppError('TaskMaster host workflows are unavailable for strict projects.', { code: 'ISOLATED_TASKMASTER_UNSUPPORTED', statusCode: 409 });
    return project?.project_path ?? null;
  },
  authorizeProject: (request, projectId) => requireOwnedProject(requireUserId(request), projectId),
  taskmasterService,
});
