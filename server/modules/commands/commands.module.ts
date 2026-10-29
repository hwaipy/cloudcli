import * as fs from 'node:fs/promises';
import os from 'node:os';

import { requireOwnedProjectPath, requireOwnedSession, requireUserId } from '@/modules/access/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter({
  authorizeContext: (req, _res, next) => {
    try {
      const userId = requireUserId(req);
      const context = req.body?.context;
      const projectPath = req.body?.projectPath ?? context?.projectPath;
      if (typeof projectPath === 'string' && projectPath) requireOwnedProjectPath(userId, projectPath);
      if (typeof context?.sessionId === 'string' && context.sessionId) requireOwnedSession(userId, context.sessionId);
      next();
    } catch (error) { next(error); }
  },
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
});
