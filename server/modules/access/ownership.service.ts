import type { Request } from 'express';

import { projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Used by authenticated routes to reject requests without a database user. */
export function requireUserId(request: Request): number {
  const user = (request as Request & { user?: { id?: unknown; userId?: unknown } }).user;
  const rawId = user?.id ?? user?.userId;
  const userId = Number(rawId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError('Authentication required.', { code: 'AUTH_REQUIRED', statusCode: 401 });
  }
  return userId;
}

/** Host-wide management endpoints are available only to the original account. */
export function requireAdmin(request: Request): number {
  const userId = requireUserId(request);
  if (userDb.getFirstUser()?.id !== userId) {
    throw new AppError('Administrator access required.', { code: 'ADMIN_REQUIRED', statusCode: 403 });
  }
  return userId;
}

/** Used by the projects and file modules to hide projects owned by another user. */
export function requireOwnedProject(userId: number, projectId: string): void {
  if (!projectsDb.getProjectById(projectId, userId)) {
    throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
}

/** Used by new-session and path-based routes before touching a workspace. */
export function requireOwnedProjectPath(userId: number, projectPath: string): void {
  const project = projectsDb.getProjectPath(projectPath);
  if (!project || project.owner_user_id !== userId) {
    throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
}

/** Used by provider routes and chat runs before reading or mutating a session. */
export function requireOwnedSession(userId: number, sessionId: string): void {
  if (!sessionsDb.getSessionById(sessionId, userId)) {
    throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
}

/** Used by realtime broadcasts to select only the session owner's clients. */
export function ownsSession(userId: number, sessionId: string): boolean {
  return Boolean(sessionsDb.getSessionById(sessionId, userId));
}
