import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { after, test } from 'node:test';

const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cloudcli-isolation-'));
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
await fs.writeFile(process.env.DATABASE_PATH, '');
process.env.CLOUDCLI_ISOLATION_STATE_DIR = path.join(directory, 'state');
const { initializeDatabase, projectsDb, closeConnection, getConnection } = await import('@/modules/database/index.js');
await initializeDatabase();
const { validateIsolationPath, resolveIsolatedProject, getIsolationCapabilities } = await import('@/modules/project-isolation/index.js');
const { startIsolationEgress } = await import('@/modules/project-isolation/egress-proxy.service.js');

after(async () => { closeConnection(); await fs.rm(directory, { recursive: true, force: true }); });

test('strict mode persists and session ownership prevents request options from escaping the project', async () => {
  const project = path.join(directory, 'project');
  await fs.mkdir(project);
  const saved = projectsDb.createProjectPath(project, 'Strict', undefined, true).project!;
  assert.equal(projectsDb.getProjectById(saved.project_id)?.strict_file_isolation, 1);
  assert.equal(resolveIsolatedProject({ projectPath: project })?.project_id, saved.project_id);
  assert.equal(resolveIsolatedProject({ cwd: path.join(project, 'src') })?.project_id, saved.project_id);
  assert.throws(() => resolveIsolatedProject({ projectId: saved.project_id, cwd: directory }), /outside/);
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path) VALUES (?, ?, ?)').run('strict-session', 'codex', project);
  const normal = projectsDb.createProjectPath(path.join(directory, 'normal')).project!;
  assert.throws(() => resolveIsolatedProject({ sessionId: 'strict-session', projectId: normal.project_id, projectPath: normal.project_path, cwd: normal.project_path }), /outside/);
});

test('mount validation rejects broad roots, aliases, host service sockets and external hard links', async () => {
  const project = path.join(directory, 'mount-check');
  await fs.mkdir(project);
  assert.equal(await validateIsolationPath(project), project);
  await assert.rejects(validateIsolationPath(os.homedir()), /dedicated project/);
  await assert.rejects(validateIsolationPath('/etc'), /dedicated project/);
  const alias = path.join(directory, 'alias');
  await fs.symlink(project, alias);
  await assert.rejects(validateIsolationPath(alias), /symlinked/);
  const outside = path.join(directory, 'secret');
  await fs.writeFile(outside, 'outside');
  await fs.link(outside, path.join(project, 'linked'));
  await assert.rejects(validateIsolationPath(project), /hard-linked/);
  await fs.unlink(path.join(project, 'linked'));
  await fs.writeFile(path.join(project, '.git'), 'gitdir: /outside/.git');
  await assert.rejects(validateIsolationPath(project), /worktree/);
});

test('unsupported backends report unavailability rather than claiming strict protection', async () => {
  const result = await getIsolationCapabilities();
  if (process.platform !== 'linux') assert.equal(result.available, false);
  if (!result.available) assert.ok(result.reason);
});

test('container egress denies HTTP and CONNECT requests to loopback, private and reserved addresses', async () => {
  const socket = path.join('/tmp', `cloudcli-egress-test-${process.pid}.sock`);
  const proxy = await startIsolationEgress(socket);
  try {
    for (const target of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
      const code = await new Promise<number>((resolve, reject) => {
        const request = http.get({ socketPath: socket, path: target }, (response) => { resolve(response.statusCode!); response.resume(); });
        request.on('error', reject);
      });
      assert.equal(code, 403, target);
    }
    for (const target of ['localhost:443', '192.168.1.1:443', '[::1]:443', 'example.com:22']) {
      const code = await new Promise<number>((resolve, reject) => {
        const request = http.request({ socketPath: socket, method: 'CONNECT', path: target });
        request.on('connect', (response, connection) => { resolve(response.statusCode!); connection.destroy(); });
        request.on('error', reject);
        request.end();
      });
      assert.equal(code, 403, target);
    }
  } finally { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await fs.rm(socket, { force: true }); }
});

test('isolation selects its dedicated Unix socket and never inherits rootful Docker context', async () => {
  const { isolationDockerArgs } = await import('@/modules/project-isolation/isolation-docker.service.js');
  const previous = process.env.CLOUDCLI_ISOLATION_DOCKER_HOST;
  const ordinary = process.env.DOCKER_HOST;
  try {
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    delete process.env.CLOUDCLI_ISOLATION_DOCKER_HOST;
    assert.deepEqual(isolationDockerArgs(['info']), ['--host', `unix:///run/user/${process.getuid?.()}/docker.sock`, 'info']);
    process.env.CLOUDCLI_ISOLATION_DOCKER_HOST = 'unix:///run/user/501/custom.sock';
    assert.deepEqual(isolationDockerArgs(['exec', 'project', 'apt-get']), ['--host', 'unix:///run/user/501/custom.sock', 'exec', 'project', 'apt-get']);
    process.env.CLOUDCLI_ISOLATION_DOCKER_HOST = 'tcp://remote:2375';
    assert.throws(() => isolationDockerArgs([]), /local Rootless/);
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_ISOLATION_DOCKER_HOST; else process.env.CLOUDCLI_ISOLATION_DOCKER_HOST = previous;
    if (ordinary === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = ordinary;
  }
});
