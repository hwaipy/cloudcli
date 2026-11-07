#!/usr/bin/env node
// Run on a Linux backend against staged build artifacts. Uses only disposable files,
// containers, volumes and a separate SQLite DB; never restarts the backend.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runProcess = promisify(execFile);
const dockerHost = process.env.CLOUDCLI_ISOLATION_DOCKER_HOST || `unix:///run/user/${process.getuid()}/docker.sock`;
const execute = (command, args, options) => runProcess(command, command === 'docker' ? ['--host', dockerHost, ...args] : args, options);
const staged = path.resolve(process.argv[2] || 'dist-server');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-isolation-live-'));
process.env.DATABASE_PATH = path.join(work, 'auth.db');
process.env.CLOUDCLI_ISOLATION_STATE_DIR = path.join(work, 'state');
await fs.writeFile(process.env.DATABASE_PATH, '');
const load = (file) => import(pathToFileURL(path.join(staged, 'server', file)).href);
const database = await load('modules/database/index.js');
await database.initializeDatabase();
const isolation = await load('modules/project-isolation/index.js');
const { createCodexAppServerRuntime } = await load('modules/providers/list/codex/codex-app-server-runtime.provider.js');
const { codexAppServer } = await load('modules/providers/list/codex/codex-app-server.client.js');
const { CodexSessionSynchronizer } = await load('modules/providers/list/codex/codex-session-synchronizer.provider.js');
const { CodexSessionsProvider } = await load('modules/providers/list/codex/codex-sessions.provider.js');
let runtime;
let project;
let container;
let watchdog;
let succeeded = false;
try {
  const projectPath = path.join(work, 'project');
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(work, 'outside-secret'), 'HOST_ONLY_SECRET');
  await fs.writeFile(path.join(projectPath, 'marker.txt'), 'PROJECT_ONLY_MARKER');
  await fs.symlink(path.join(work, 'outside-secret'), path.join(projectPath, 'escape-link'));
  await isolation.preflightProjectIsolation(projectPath);
  project = database.projectsDb.createProjectPath(projectPath, 'Isolation verification', undefined, true).project;
  container = await isolation.ensureProjectContainer(project);
  const docker = (args) => execute('docker', ['exec', container, ...args], { timeout: 30_000 });
  const probe = `const fs=require('fs');for(const p of [${JSON.stringify(path.join(work, 'outside-secret'))},${JSON.stringify(path.join(projectPath, 'escape-link'))},'/var/run/docker.sock',${JSON.stringify(path.join(os.homedir(), '.ssh'))}]){if(fs.existsSync(p))throw Error('Host resource visible: '+p)};fs.writeFileSync('/usr/local/isolation-proof','CONTAINER_ONLY');if(process.getuid()!==0)throw Error('Package installation requires namespace root');console.log('FILESYSTEM_BOUNDARY_OK uid='+process.getuid());`;
  console.log((await docker(['/usr/local/bin/node', '-e', probe])).stdout.trim());
  const privateRequest = await docker(['curl', '-sS', '--max-time', '12', '-o', '/dev/null', '-w', '%{http_code}', 'http://169.254.169.254/']);
  assert.equal(privateRequest.stdout, '403');
  console.log('PRIVATE_NETWORK_DENIED');
  const publicRequest = await docker(['curl', '-sS', '--max-time', '25', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
  assert.equal(publicRequest.stdout, '200');
  console.log('PUBLIC_HTTPS_OK');
  const config = JSON.parse((await execute('docker', ['inspect', container])).stdout)[0];
  assert.equal(config.HostConfig.NetworkMode, 'none');
  assert.equal(config.HostConfig.ReadonlyRootfs, false);
  assert.equal(config.Config.User, '0:0');
  assert.ok(!config.HostConfig.CapAdd.includes('SYS_ADMIN'));
  assert.ok(!config.HostConfig.Privileged);
  const mapping = (await docker(['cat', '/proc/self/uid_map'])).stdout.trim().split(/\s+/).map(Number);
  assert.equal(mapping[0], 0); assert.equal(mapping[1], process.getuid()); assert.notEqual(mapping[1], 0);
  console.log('ROOTLESS_UID_MAPPING_OK');
  assert.equal(config.Mounts.filter((mount) => mount.Type === 'bind').length, 2);
  assert.ok(config.Mounts.some((mount) => mount.Type === 'volume'));
  assert.ok(!(config.Config.Env || []).some((value) => /^(OPENAI_API_KEY|CLOUDCLI_HUB_REGISTRATION_KEY)=/.test(value)));
  console.log('NO_HOST_AUTH_OR_DOCKER_SOCKET_MOUNT');
  if (process.env.ISOLATION_VERIFY_APT === '1') {
    await execute('docker', ['exec', '-e', 'DEBIAN_FRONTEND=noninteractive', container, 'sh', '-c', 'apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=30 update && apt-get install -y --no-install-recommends kicad ngspice gmsh'], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    const packages = await docker(['dpkg-query', '-W', '-f=${db:Status-Status}\n', 'kicad', 'ngspice', 'gmsh']);
    assert.deepEqual(packages.stdout.trim().split('\n'), ['installed', 'installed', 'installed']);
    await docker(['sh', '-c', 'ngspice --version >/dev/null && gmsh --version']);
    await execute('docker', ['stop', '--time', '3', container]);
    await execute('docker', ['start', container]);
    await docker(['sh', '-c', 'ngspice --version >/dev/null && gmsh --version']);
    console.log('REAL_APT_KICAD_NGSPICE_GMSH_AND_RESTART_PERSISTENCE_OK');
  }

  if (process.env.ISOLATION_VERIFY_EXEC_ONLY === '1') {
    const result = await execute('docker', ['exec', container, 'codex', '-m', process.env.ISOLATION_VERIFY_MODEL || 'gpt-6-luna', 'exec', '--skip-git-repo-check', '--json', 'Reply exactly CONTAINER_EXEC_OK without using tools.'], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    assert.match(result.stdout, /CONTAINER_EXEC_OK/);
    console.log('CONTAINER_EXEC_AUTH_OK');
    succeeded = true;
  } else {
  let nativeId = null;
  const events = [];
  const session = database.sessionsDb.createSession('isolation-verify-session', 'codex', projectPath);
  const context = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (_session, model) => model,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (raw) => [raw], isProviderInstalled: async () => true,
  };
  const writer = { isWebSocketWriter: true, setSessionId: (id) => { nativeId = id; }, send: (event) => events.push(event) };
  const options = { sessionId: session, cwd: projectPath, projectPath, model: process.env.ISOLATION_VERIFY_MODEL || 'gpt-6-luna', permissionMode: 'bypassPermissions' };
  runtime = createCodexAppServerRuntime({ idleMs: 1000, turnTimeoutMs: 180_000 });
  watchdog = setTimeout(() => { console.error('Isolated Codex verification timed out'); process.exitCode = 1; void runtime.shutdownAll(); }, 240_000);
  await runtime.run('Read marker.txt, write proof.txt containing the same marker followed by ISOLATED_WRITE_OK. Use a file tool to do this. Also install jq using apt-get and verify jq --version. Reply exactly RUNTIME_OK.', options, writer, context);
  const failed = events.find((event) => event.kind === 'error');
  if (failed) console.log('CODEX_DIAGNOSTICS', events.filter((event) => event.kind === 'error').map((event) => String(event.content).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 800)));
  console.log('CODEX_COMPLETE_STATUS', events.filter((event) => event.kind === 'complete').map((event) => event.exitCode));
  assert.ok(nativeId, 'native thread created');
  assert.match(await fs.readFile(path.join(projectPath, 'proof.txt'), 'utf8'), /ISOLATED_WRITE_OK/);
  try { await docker(['jq', '--version']); } catch (error) {
    console.log('CODEX_FINAL_DIAGNOSTIC', events.filter((event) => event.itemType === 'agent_message').slice(-1).map((event) => String(event.message?.content || event.text || '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(-1600)));
    throw error;
  }
  console.log('REAL_CODEX_TURN_WRITE_AND_APT_OK');
  await runtime.shutdownAll();
  await execute('docker', ['rm', '-f', container]); // A fresh container must resume from its retained private volume.
  runtime = createCodexAppServerRuntime({ idleMs: 1000, turnTimeoutMs: 180_000 });
  events.length = 0;
  await runtime.run('Read proof.txt and reply exactly RESUME_OK.', options, writer, context);
  if (events.some((event) => event.kind === 'error')) throw new Error('Codex resume failed');
  assert.match(JSON.stringify(events), /RESUME_OK/);
  console.log('REAL_CODEX_RESUME_OK');
  await runtime.shutdownAll();
  const fork = await codexAppServer.forkThread({ threadId: nativeId, cwd: projectPath });
  await fs.access(fork.path);
  const indexed = await new CodexSessionSynchronizer().synchronizeFile(fork.path);
  assert.ok(indexed);
  const history = await new CodexSessionsProvider().fetchHistory(indexed, { limit: 100, offset: 0 });
  assert.ok(history.messages.length > 0);
  assert.match(JSON.stringify(history), /PROJECT_ONLY_MARKER|RUNTIME_OK|RESUME_OK/);
  console.log('PRIVATE_HISTORY_EXPORT_FORK_AND_READ_OK');
  const fixtureId = '11111111-1111-4111-8111-111111111111';
  const fixtureRelative = `sessions/snapshot-fixture-${fixtureId}.jsonl`;
  const fixtureBody = JSON.stringify({ type: 'session_meta', payload: { id: fixtureId, cwd: projectPath } }) + '\n';
  await docker(['node', '-e', "require('fs').writeFileSync(process.env.CODEX_HOME+'/'+process.argv[1],process.argv[2])", fixtureRelative, fixtureBody]);
  const publisher = await isolation.isolatedCodexLaunch(project);
  try {
    await publisher.syncState();
    const fixturePath = path.join(work, 'state', project.project_id, 'codex', fixtureRelative);
    const fixtureSession = await new CodexSessionSynchronizer().synchronizeFile(fixturePath);
    assert.ok(fixtureSession);
    database.sessionsDb.updateSessionIsArchived(fixtureSession, true);
    const beforeSnapshot = await fs.stat(fixturePath);
    await publisher.syncState();
    await new CodexSessionSynchronizer().synchronizeFile(fixturePath);
    const afterSnapshot = await fs.stat(fixturePath);
    assert.equal(afterSnapshot.mtimeMs, beforeSnapshot.mtimeMs);
    assert.equal(afterSnapshot.ino, beforeSnapshot.ino);
    assert.equal(Boolean(database.sessionsDb.getSessionById(fixtureSession).isArchived), true);
    console.log('REAL_CONTAINER_EXPORT_PRESERVES_ARCHIVED_SESSION_OK');
  } finally { publisher.cleanup(); }

  const markerPath = path.join(work, 'state', project.project_id, 'codex', '.credential-source');
  const currentMarker = await fs.readFile(markerPath, 'utf8');
  await docker(['sh', '-c', 'echo malicious > "$CODEX_HOME/.credential-source"']);
  assert.equal(await fs.readFile(markerPath, 'utf8'), currentMarker, 'container cannot alter host snapshot or credential tracking');
  console.log('HOST_SNAPSHOT_NOT_WRITABLE_FROM_CONTAINER');
  // A configuration update must preserve tokens refreshed in the private volume.
  const { default: TOML } = await import('@iarna/toml');
  const originalHome = process.env.CODEX_HOME;
  const sourceHome = originalHome || path.join(os.homedir(), '.codex');
  const sourceCopy = path.join(work, 'credential-source-fixture');
  await fs.mkdir(sourceCopy, { mode: 0o700 });
  const sourceConfig = TOML.parse(await fs.readFile(path.join(sourceHome, 'config.toml'), 'utf8'));
  sourceConfig.model_reasoning_effort = sourceConfig.model_reasoning_effort === 'low' ? 'medium' : 'low';
  await fs.writeFile(path.join(sourceCopy, 'config.toml'), TOML.stringify(sourceConfig), { mode: 0o600 });
  try { await fs.copyFile(path.join(sourceHome, 'auth.json'), path.join(sourceCopy, 'auth.json')); await fs.chmod(path.join(sourceCopy, 'auth.json'), 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await docker(['node', '-e', "require('fs').writeFileSync(process.env.CODEX_HOME+'/auth.json','PRIVATE_REFRESH_SENTINEL')"]);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    process.env.CODEX_HOME = sourceCopy;
    await isolation.ensureProjectContainer(project);
    await docker(['node', '-e', "if(require('fs').readFileSync(process.env.CODEX_HOME+'/auth.json','utf8')!=='PRIVATE_REFRESH_SENTINEL')process.exit(7)"]);
    console.log('CONFIG_UPDATE_PRESERVES_PRIVATE_REFRESHED_AUTH_OK');
  } finally { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; }

  console.log('ISOLATION_LIVE_VERIFICATION_OK');
  succeeded = true;
  }
} finally {
  clearTimeout(watchdog);
  await runtime?.shutdownAll();
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!succeeded && process.env.ISOLATION_KEEP_FAILED === '1') {
    console.log('FAILED_REVIEW_RESOURCES', work, project?.project_id);
    database.closeConnection();
  } else {
  if (!container && project) container = `cloudcli-isolated-${project.project_id}`;
  if (container) await execute('docker', ['rm', '-f', container]).catch(() => {});
  if (project) await execute('docker', ['volume', 'rm', `cloudcli-codex-state-${project.project_id}`]).catch(() => {});
  database.closeConnection();
  await fs.rm(work, { recursive: true, force: true });
  }
}
