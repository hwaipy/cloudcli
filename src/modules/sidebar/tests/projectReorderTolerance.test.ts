import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project } from '@/shared/types';
import { sortProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';

const project = (projectId: string, lastActivity: string, isStarred = false): Project => ({
  projectId,
  displayName: projectId,
  isStarred,
  sessions: [{ id: `${projectId}-session`, lastActivity }],
} as Project);

const ids = (projects: Project[]) => projects.map((item) => item.projectId);

test('a newly loaded project list uses exact send-time order', () => {
  const projects = [
    project('older', '2026-10-29T10:00:00.000Z'),
    project('newer', '2026-10-29T10:09:00.000Z'),
  ];

  assert.deepEqual(ids(sortProjects(projects, 'date')), ['newer', 'older']);
  // A changed project set is another fresh load, not a continuation of the old order.
  assert.deepEqual(ids(sortProjects(projects, 'date', ['older'])), ['newer', 'older']);
});

test('live updates only move a project when its activity is over ten minutes newer', () => {
  const older = project('older', '2026-10-29T10:00:00.000Z');
  const order = ['older', 'active'];

  assert.deepEqual(ids(sortProjects([
    older, project('active', '2026-10-29T10:09:59.000Z'),
  ], 'date', order)), order);
  assert.deepEqual(ids(sortProjects([
    older, project('active', '2026-10-29T10:10:00.000Z'),
  ], 'date', order)), order);
  assert.deepEqual(ids(sortProjects([
    older, project('active', '2026-10-29T10:10:01.000Z'),
  ], 'date', order)), ['active', 'older']);
});

test('ten-minute stability still respects wider time gaps and pinned projects', () => {
  const projects = [
    project('old', '2026-10-29T10:00:00.000Z'),
    project('middle', '2026-10-29T10:08:00.000Z'),
    project('new', '2026-10-29T10:16:00.000Z'),
  ];

  const ordered = sortProjects(projects, 'date', ['old', 'middle', 'new']);
  assert.equal(ids(ordered).indexOf('new') < ids(ordered).indexOf('old'), true);
  assert.deepEqual(ids(sortProjects([
    project('pinned', '2026-10-29T09:00:00.000Z', true),
    project('recent', '2026-10-29T10:16:00.000Z'),
  ], 'date', ['recent', 'pinned'])), ['pinned', 'recent']);
  assert.deepEqual(ids(sortProjects(projects, 'name', ['new', 'middle', 'old'])), ['middle', 'new', 'old']);
});
