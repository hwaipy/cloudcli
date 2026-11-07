import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { canReadAsset } from '@/modules/assets/index.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import type { AnyRecord, ProjectRepositoryRow, CodexProcessLaunch } from '@/shared/types.js';

import { executeIsolationDocker, spawnIsolationDocker, isolationDockerArgs } from './isolation-docker.service.js';
import { ensureIsolationImage } from './isolation-image.service.js';
import { importLegacyIsolation } from './isolation-migration.service.js';
import { isolationHistoryManifestScript, isolationHistoryFileScript, parseIsolationHistoryManifest, publishIsolationHistorySnapshot } from './history-snapshot.service.js';
import { waitForContainerProxy } from './isolation-ssh-initialization.service.js';
import { configureContainerSshAccess } from './isolation-ssh.service.js';
import { startIsolationEgress } from './egress-proxy.service.js';

const POLICY = '2';
const PACKAGE_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'SETFCAP', 'KILL'];
const preparing = new Map<string, Promise<string>>();
const snapshotExports = new Map<string, Promise<string[]>>();
let egress: Promise<unknown> | undefined;
const users = new Map<string, number>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function failure(message: string): AppError {
  return new AppError(message, { code: 'PROJECT_ISOLATION_UNAVAILABLE', statusCode: 409 });
}

/** Used by Codex indexing and watchers to locate private project runtime state without sharing the user's main Codex home. */
export function isolationStateRoot(): string {
  return path.resolve(process.env.CLOUDCLI_ISOLATION_STATE_DIR || path.join(os.homedir(), '.cloudcli', 'isolated-projects'));
}

/** Used by project creation to detect supported local Linux Docker engines; remote daemons cannot mount local project paths safely. */
export async function getIsolationCapabilities(): Promise<{ available: boolean; reason?: string; rootless?: boolean }> {
  if (process.platform !== 'linux') return { available: false, reason: 'Strict isolation currently requires a Linux backend with a local Docker engine.' };
  try {
    const { stdout } = await executeIsolationDocker(['info', '--format', '{{json .}}'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    if (info.OSType !== 'linux') throw new Error('Docker must run Linux containers');
    if (!(info.SecurityOptions ?? []).some((option: string) => option.includes('seccomp'))) throw new Error('Docker seccomp protection is required');
    if (!info.SecurityOptions.some((option: string) => option.includes('rootless'))) throw new Error('A Rootless Docker daemon is required');
    if (info.CgroupVersion !== '2' || info.CgroupDriver !== 'systemd' || info.MemoryLimit === false || info.PidsLimit === false) throw new Error('Rootless Docker requires delegated cgroup v2 resource controls');
    return { available: true, rootless: true };
  } catch { return { available: false, reason: 'A reachable local Rootless Docker engine with seccomp and delegated cgroup v2 is required.' }; }
}

/** Used by creation and every runtime launch to reject unsafe project mounts before exposing them to a container. */
export async function validateIsolationPath(projectPath: string): Promise<string> {
  const root = await fs.realpath(projectPath);
  const home = await fs.realpath(os.homedir());
  const state = isolationStateRoot();
  const overlap = (left: string, right: string) => left === right || right.startsWith(left + path.sep);
  if (root !== path.resolve(projectPath) || root.includes(',') || /[\r\n\0]/.test(root)
    || /^\/(Users|home)\/[^/]+$/.test(root)
    || ['/', '/Users', '/home', '/root', '/etc', '/proc', '/sys', '/dev', '/run', '/var', '/usr', '/bin', '/sbin', '/tmp'].includes(root)
    || overlap(root, home) || overlap(root, state) || overlap(state, root)
    || ['/proc', '/sys', '/dev', '/run', '/etc', '/usr', '/bin', '/sbin'].some((prefix) => overlap(prefix, root))) {
    throw failure('Choose a dedicated project directory; system paths, home roots, runtime state and symlinked roots cannot be isolated.');
  }
  const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  for (const line of mountInfo.trim().split('\n')) {
    const point = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (point && point.startsWith(root + '/')) throw failure('Project contains a nested filesystem mount. Remove it before enabling strict isolation.');
  }
  let count = 0;
  const links = new Map<string, { seen: number; total: number }>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 250_000) throw failure('Project is too large for the strict mount safety check.');
      const filename = path.join(directory, entry.name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) continue; // The container resolves links in its own mount namespace.
      if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) throw failure('Project contains a socket, device or FIFO; strict isolation cannot expose host service endpoints.');
      if (stat.isFile() && stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        const entry = links.get(key) ?? { seen: 0, total: stat.nlink };
        entry.seen += 1; links.set(key, entry);
      }
      if (entry.name === '.git' && stat.isFile()) throw failure('External Git worktree metadata is not supported in strict isolation yet.');
      if (stat.isDirectory()) await walk(filename);
    }
  }
  await walk(root);
  if ([...links.values()].some((entry) => entry.seen < entry.total)) throw failure('Project contains externally hard-linked files; create independent copies before enabling strict isolation.');
  return root;
}

/** Used by runtime entry points to resolve isolation from persisted ownership, never from a client-supplied opt-out flag. */
export function resolveIsolatedProject(options: AnyRecord): ProjectRepositoryRow | null {
  const session = typeof options.sessionId === 'string' ? sessionsDb.getSessionById(options.sessionId) : null;
  const sessionProject = session?.project_path ? projectsDb.getProjectPath(session.project_path) : null;
  const byId = typeof options.projectId === 'string' ? projectsDb.getProjectById(options.projectId) : null;
  const requestedPaths = [options.projectPath, options.cwd].filter((value): value is string => typeof value === 'string').map((value) => path.resolve(value));
  const strictCandidates = [sessionProject, byId, ...requestedPaths.map((value) => projectsDb.getProjectPath(value)),
    ...projectsDb.getProjectPaths().filter((project) => project.strict_file_isolation && requestedPaths.some((value) => value.startsWith(project.project_path + path.sep)))].filter((project): project is ProjectRepositoryRow => Boolean(project?.strict_file_isolation));
  if (!strictCandidates.length) return null;
  const row = strictCandidates[0];
  if (strictCandidates.some((project) => project.project_id !== row.project_id)) throw failure('Conflicting isolated project identities.');
  const cwd = path.resolve(String(options.cwd || row.project_path));
  if (cwd !== row.project_path && !cwd.startsWith(row.project_path + path.sep)) throw failure('Working directory is outside the isolated project.');
  return row;
}

async function seedCredentials(codexHome: string, container: string): Promise<void> {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sourceConfig = await fs.readFile(path.join(source, 'config.toml'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const config = TOML.parse(sourceConfig) as AnyRecord;
  const selectedProvider = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
  const provider = config.model_providers?.[selectedProvider];
  const clean: AnyRecord = {
    cli_auth_credentials_store: 'file',
    developer_instructions: 'You are running inside a project-isolated Rootless Docker container as container root. Install required system packages directly with apt-get (no sudo required). System packages persist across normal container and backend restarts. The host filesystem outside this project is not mounted. Kernel modules and host-level system services are unavailable; prefer headless command-line workflows.',
  };
  for (const key of ['model', 'review_model', 'model_provider', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit', 'model_reasoning_summary']) {
    if (config[key] !== undefined) clean[key] = config[key];
  }
  if (provider && typeof provider === 'object') {
    const entry: AnyRecord = {};
    for (const key of ['name', 'base_url', 'model_catalog_url', 'wire_api', 'requires_openai_auth', 'experimental_bearer_token', 'http_headers']) if (provider[key] !== undefined) entry[key] = provider[key];
    if (typeof provider.env_key === 'string') {
      const secret = process.env[provider.env_key];
      if (!secret) throw failure('Selected model provider API key is not available to the backend.');
      entry.experimental_bearer_token = secret;
    }
    clean.model_providers = { [selectedProvider]: entry };
  }
  clean.features = { api_key_model_discovery: config.features?.api_key_model_discovery === true, goals: config.features?.goals === true };
  const auth = process.env.OPENAI_API_KEY && !provider
    ? JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY })
    : await fs.readFile(path.join(source, 'auth.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!auth && !clean.model_providers?.[selectedProvider]?.experimental_bearer_token && provider?.requires_openai_auth !== false) {
    throw failure('No transferable Codex authentication was found. File-based login credentials or a provider API key are required.');
  }
  const configText = TOML.stringify(clean);
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const authSourceHash = digest(auth);
  const configSourceHash = digest(configText);
  const marker = path.join(codexHome, '.credential-source');
  const previous = await fs.readFile(marker, 'utf8').catch(() => '');
  let tracking: { authSourceHash?: string; configSourceHash?: string } = {};
  try { tracking = JSON.parse(previous); } catch { /* v1 used a single combined fingerprint. */ }
  if (tracking.authSourceHash === authSourceHash && tracking.configSourceHash === configSourceHash) return;
  const legacyConfig = { ...clean }; delete legacyConfig.developer_instructions;
  const legacyUnchanged = previous === digest(TOML.stringify(legacyConfig) + auth) || previous === digest(configText + auth);
  const replaceAuth = tracking.authSourceHash ? tracking.authSourceHash !== authSourceHash : !legacyUnchanged;
  if ((users.get(codexHome) ?? 0) > 0) throw failure('Authentication changed while an isolated session is running. Stop its active sessions before refreshing credentials.');
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  // Secrets travel through stdin, never Docker arguments, image layers, environment inspection or host bind mounts.
  await new Promise<void>((resolve, reject) => {
    const child = spawnIsolationDocker(['exec', '-i', container, '/usr/local/bin/node', '-e', `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const fs=require('fs'),p=require('path'),v=JSON.parse(data),h=process.env.CODEX_HOME;for(const [name,body] of Object.entries(v)){const file=p.join(h,name),temp=p.join(h,'.seed-'+require('crypto').randomUUID());if(body){fs.writeFileSync(temp,body,{mode:0o600,flag:'wx'});fs.renameSync(temp,file)}else{try{fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}}}});`]);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(failure('Could not provision container authentication')));
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ 'config.toml': configText, ...(replaceAuth ? { 'auth.json': auth } : {}) }));
  });
  await fs.writeFile(marker, JSON.stringify({ version: 2, authSourceHash, configSourceHash }), { mode: 0o600 });
}

/** Used by project creation to check the mount and warm the pinned image before persisting strict mode. */
export async function preflightProjectIsolation(projectPath: string): Promise<void> {
  const capability = await getIsolationCapabilities();
  if (!capability.available) throw failure(capability.reason!);
  await validateIsolationPath(projectPath);
  await fs.mkdir(isolationStateRoot(), { recursive: true, mode: 0o700 });
  await ensureIsolationImage(isolationStateRoot());
}

/** Used by Codex and the project terminal to create/reuse a container with no host network and only three explicit mounts. */
export async function ensureProjectContainer(project: ProjectRepositoryRow): Promise<string> {
  const pending = preparing.get(project.project_id);
  if (pending) return pending;
  const promise = (async () => {
    const capability = await getIsolationCapabilities();
    if (!capability.available) throw failure(capability.reason!);
    const root = await validateIsolationPath(project.project_path);
    const state = path.join(isolationStateRoot(), project.project_id, 'codex');
    const socketDirectory = path.join(isolationStateRoot(), '.egress');
    const ownerFile = path.join(path.dirname(state), '.backend-owner');
    const oldOwner = Number(await fs.readFile(ownerFile, 'utf8').catch(() => '0'));
    if (oldOwner && oldOwner !== process.pid) {
      let alive = true;
      try { process.kill(oldOwner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) throw failure('This isolated project is owned by another running backend process.');
    }
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    if (!egress) egress = startIsolationEgress(path.join(socketDirectory, 'proxy.sock')).catch((error) => { egress = undefined; throw error; });
    await egress;
    const image = await ensureIsolationImage(isolationStateRoot());
    const imageId = (await executeIsolationDocker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    const uid = 0;
    const gid = 0;
    const name = `cloudcli-isolated-${project.project_id}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw failure('Invalid isolated project identifier');
    const volume = `cloudcli-codex-state-${project.project_id}`;
    const mounts = [[root, root], [socketDirectory, '/run/cloudcli-egress']];
    let container: AnyRecord | null = null;
    try { container = JSON.parse((await executeIsolationDocker(['inspect', name])).stdout)[0]; } catch { /* Missing container is created below. */ }
    if (container) {
      // Approved v2 images retain their writable layer and state volumes. SSH
      // tools are repaired in place under the shared initialization lock.
      let compatibleImage = container.Image === imageId;
      if (!compatibleImage && image.includes(':v2-ssh1-')) {
        const legacyTag = image.replace(':v2-ssh1-', ':v2-');
        try { compatibleImage = container.Image === (await executeIsolationDocker(['image', 'inspect', '--format', '{{.Id}}', legacyTag])).stdout.trim(); } catch { /* No approved legacy image. */ }
      }
      const actualMounts = container.Mounts ?? [];
      const actualCapabilities = (container.HostConfig.CapAdd ?? []).map((capability: string) => capability.replace(/^CAP_/, ''));
      if (!compatibleImage || container.Config.Labels?.['cloudcli.isolation-policy'] !== POLICY
        || container.Config.User !== `${uid}:${gid}` || container.HostConfig.Privileged || container.HostConfig.ReadonlyRootfs
        || container.HostConfig.NetworkMode !== 'none' || !container.HostConfig.CapDrop?.includes('ALL')
        || !container.HostConfig.SecurityOpt?.includes('no-new-privileges')
        || actualCapabilities.length !== PACKAGE_CAPABILITIES.length
        || PACKAGE_CAPABILITIES.some((capability) => !actualCapabilities.includes(capability))
        || container.HostConfig.Memory !== 2 * 1024 ** 3 || container.HostConfig.NanoCpus !== 2_000_000_000 || container.HostConfig.PidsLimit !== 256
        || mounts.some(([source, destination]) => !container.HostConfig.Mounts?.some((mount: AnyRecord) => mount.Type === 'bind' && mount.Source === source && mount.Target === destination && mount.BindOptions?.NonRecursive === true))
        || actualMounts.length !== mounts.length + 1
        || !actualMounts.some((mount: AnyRecord) => mount.Type === 'volume' && mount.Name === volume && mount.Destination === state && mount.RW) || mounts.some(([source, destination]) => !actualMounts.some((mount: AnyRecord) => mount.Source === source && mount.Destination === destination && (destination === '/run/cloudcli-egress' ? !mount.RW : mount.RW)))) {
        throw failure('Existing project container does not match its isolation policy. Remove only that project container and retry.');
      }
    } else {
      let volumeExists = false;
      try { await executeIsolationDocker(['volume', 'inspect', volume]); volumeExists = true; } catch { /* First creation seeds authentication below. */ }
      await executeIsolationDocker(['volume', 'create', '--label', `cloudcli.project-id=${project.project_id}`, volume]);
      await executeIsolationDocker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--user', '0:0', '--mount', `type=volume,src=${volume},dst=/state`, '--entrypoint', 'chown', image, `${uid}:${gid}`, '/state']);
      if (!volumeExists) {
        const previousCredentials = await fs.stat(path.join(state, '.credential-source')).then(() => true).catch(() => false);
        try { await importLegacyIsolation(project, image, volume, previousCredentials); } catch (error) {
          await executeIsolationDocker(['volume', 'rm', volume]).catch(() => {});
          throw error;
        }
      }
      const args = ['create' , '--name', name, '--label', `cloudcli.isolation-policy=${POLICY}`, '--label', `cloudcli.project-id=${project.project_id}`,
        ...PACKAGE_CAPABILITIES.flatMap((capability) => ['--cap-add', capability]),
        '--init', '--user', `${uid}:${gid}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--workdir', root,
        '--tmpfs', `/tmp:rw,nosuid,nodev,size=512m,uid=${uid},gid=${gid}`,
        '--tmpfs', `/home/codex:rw,nosuid,nodev,size=512m,uid=${uid},gid=${gid}`,
        '--env', `CODEX_HOME=${state}`,
        '--mount', `type=volume,src=${volume},dst=${state}`,
        ...mounts.flatMap(([source, destination]) => ['--mount', `type=bind,src=${source},dst=${destination},bind-recursive=disabled${destination === '/run/cloudcli-egress' ? ',readonly' : ''}`]), image];
      await executeIsolationDocker(args, { timeout: 30_000 });
    }
    if (oldOwner && oldOwner !== process.pid && container?.State?.Running) {
      await executeIsolationDocker(['stop', '--time', '5', name]);
      container.State.Running = false;
    }
    if (!container?.State?.Running) await executeIsolationDocker(['start', name], { timeout: 30_000 });
    await waitForContainerProxy(name);
    await fs.writeFile(ownerFile, String(process.pid), { mode: 0o600 });
    await seedCredentials(state, name);
    if (process.env.CLOUDCLI_ISOLATION_SSH_AGENT === '1') await configureContainerSshAccess(name);
    if (!users.get(state) && !idleTimers.has(name)) holdContainer(name, state)();
    return name;
  })();
  preparing.set(project.project_id, promise);
  try { return await promise; } finally { preparing.delete(project.project_id); }
}

function holdContainer(name: string, state: string): () => void {
  const timer = idleTimers.get(name);
  if (timer) clearTimeout(timer);
  idleTimers.delete(name);
  users.set(state, (users.get(state) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users.set(state, Math.max(0, (users.get(state) ?? 1) - 1));
    if (!users.get(state)) {
      const idle = setTimeout(() => { if (!users.get(state)) void executeIsolationDocker(['stop', '--time', '5', name]).catch(() => {}); idleTimers.delete(name); }, 10 * 60_000);
      idle.unref(); idleTimers.set(name, idle);
    }
  };
}

/** Used by the App Server transport to launch only inside the project's persisted strict container. */
export async function isolatedCodexLaunch(project: ProjectRepositoryRow): Promise<CodexProcessLaunch> {
  const name = await ensureProjectContainer(project);
  const state = path.join(isolationStateRoot(), project.project_id, 'codex');
  const release = holdContainer(name, state);
  const pidFile = path.join(state, `app-server-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
  let released = false;
  return {
    syncState: () => exportIsolationHistory(project, name),
    command: 'docker', args: isolationDockerArgs(['exec', ...(process.env.CLOUDCLI_ISOLATION_SSH_AGENT === '1' ? ['-e', 'SSH_AUTH_SOCK=/run/cloudcli-egress/ssh-agent.sock'] : []), '-i', name, 'sh', '-c', 'echo $$ > "$1"; exec codex app-server', 'codex', pidFile]),
    cleanup: () => {
      if (released) return;
      released = true;
      void (async () => {
        const pid = (await executeIsolationDocker(['exec', name, 'cat', pidFile]).then((result) => result.stdout).catch(() => '')).trim();
        if (/^[0-9]+$/.test(pid) && Number(pid) > 1) await executeIsolationDocker(['exec', name, 'kill', '-TERM', pid]).catch(() => {});
        await executeIsolationDocker(['exec', name, 'rm', '-f', pidFile]).catch(() => {});
        release();
      })();
    },
  };
}

/** Used by the shell gateway to keep plain terminals inside the same strict filesystem boundary. */
export async function isolatedShellLaunch(project: ProjectRepositoryRow, command: string): Promise<{ command: string; args: string[]; cleanup: () => void }> {
  const name = await ensureProjectContainer(project);
  const release = holdContainer(name, path.join(isolationStateRoot(), project.project_id, 'codex'));
  return { cleanup: () => { void exportIsolationHistory(project, name).catch(() => {}).finally(release); }, command: 'docker', args: isolationDockerArgs(['exec', ...(process.env.CLOUDCLI_ISOLATION_SSH_AGENT === '1' ? ['-e', 'SSH_AUTH_SOCK=/run/cloudcli-egress/ssh-agent.sock'] : []), '-it', name, 'bash', '-c', command]) };
}

/** Used by session scanning to enumerate only the isolated Codex homes belonging to persisted strict projects. */
export function isolatedCodexHomes(): string[] {
  return [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()]
    .filter((project) => project.strict_file_isolation)
    .map((project) => path.join(isolationStateRoot(), project.project_id, 'codex'));
}

/** Used by App Server completion and forks to publish only regular, bounded rollout files into a host-only snapshot directory. */
async function exportIsolationHistory(project: ProjectRepositoryRow, container: string): Promise<string[]> {
  const previous = snapshotExports.get(project.project_id) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => publishContainerHistory(project, container));
  snapshotExports.set(project.project_id, pending);
  try { return await pending; } finally { if (snapshotExports.get(project.project_id) === pending) snapshotExports.delete(project.project_id); }
}

async function publishContainerHistory(project: ProjectRepositoryRow, container: string): Promise<string[]> {
  const state = path.join(isolationStateRoot(), project.project_id, 'codex');
  const { stdout } = await executeIsolationDocker(['exec', container, '/usr/local/bin/node', '-e', isolationHistoryManifestScript()], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  const entries = parseIsolationHistoryManifest(JSON.parse(stdout));
  const published: string[] = [];
  const indexedPaths = new Set(sessionsDb.getSessionsByProjectPathIncludingArchived(project.project_path).map((session) => session.jsonl_path));
  // Newest files first; one oversized historical transcript must not prevent a new thread from being published.
  for (const entry of entries.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    if (entry.size > 128 * 1024 * 1024) {
      console.warn('[IsolationHistory] Skipping oversized file', { projectId: project.project_id, path: entry.path, bytes: entry.size });
      continue;
    }
    const target = path.resolve(state, entry.path);
    if (!target.startsWith(path.resolve(state) + path.sep)) throw failure('Invalid isolated history path');
    const existing = await fs.stat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!existing || existing.size !== entry.size || Math.abs(existing.mtimeMs - entry.mtimeMs) >= 1) {
      const result = await executeIsolationDocker(['exec', container, '/usr/local/bin/node', '-e', isolationHistoryFileScript(), entry.path], { maxBuffer: 192 * 1024 * 1024, timeout: 60_000 });
      const snapshot: unknown = JSON.parse(result.stdout);
      if (!snapshot || typeof snapshot !== 'object' || (snapshot as AnyRecord).path !== entry.path) throw failure('History snapshot does not match requested file');
      if (await publishIsolationHistorySnapshot(state, snapshot) && entry.path !== 'session_index.jsonl') published.push(target);
    } else if (entry.path !== 'session_index.jsonl' && !indexedPaths.has(target)) {
      // A previous publication may have succeeded before indexing was interrupted.
      published.push(target);
    }
  }
  return published;
}

/** Used by isolated Codex turns to copy only authorized uploads into their private volume, without mounting the global asset store. */
export async function stageIsolationAttachments(project: ProjectRepositoryRow, descriptors: AnyRecord[], userId?: number): Promise<AnyRecord[]> {
  if (!descriptors.length) return [];
  const container = await ensureProjectContainer(project);
  const assets = await fs.realpath(path.join(os.homedir(), '.cloudcli', 'assets'));
  const result: AnyRecord[] = [];
  for (const descriptor of descriptors) {
    const source = await fs.realpath(String(descriptor.path));
    if (source.startsWith(project.project_path + path.sep)) { result.push(descriptor); continue; }
    if (path.dirname(source) !== assets || !userId || !canReadAsset(path.basename(source), userId)) throw failure('Attachment is outside the project and is not an authorized upload.');
    const info = await fs.lstat(source);
    if (!info.isFile() || info.size > 200 * 1024 * 1024) throw failure('Invalid isolated attachment.');
    const destination = path.join(isolationStateRoot(), project.project_id, 'codex', 'inputs', `${Date.now()}-${createHash('sha256').update(source).digest('hex').slice(0, 16)}-${path.basename(source)}`);
    const child = spawnIsolationDocker(['exec', '-i', container, '/usr/local/bin/node', '-e', `const fs=require('fs'),p=require('path'),f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true});process.stdin.pipe(fs.createWriteStream(f,{mode:0o600}));`, destination]);
    const completed = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(failure('Container attachment copy failed'))); });
    const input = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await Promise.all([pipeline(input.createReadStream(), child.stdin), completed]);
    result.push({ ...descriptor, path: destination });
  }
  return result;
}

/** Used by project creation rollback and permanent deletion to remove only that project's managed runtime resources. */
export async function removeProjectIsolation(project: ProjectRepositoryRow): Promise<void> {
  if (!project.strict_file_isolation || !/^[a-zA-Z0-9_-]+$/.test(project.project_id)) return;
  const name = `cloudcli-isolated-${project.project_id}`;
  const timer = idleTimers.get(name);
  if (timer) clearTimeout(timer);
  idleTimers.delete(name);
  for (const [kind, resource] of [['container', name], ['volume', `cloudcli-codex-state-${project.project_id}`]]) {
    let metadata: AnyRecord;
    try { metadata = JSON.parse((await executeIsolationDocker([kind, 'inspect', resource])).stdout)[0]; } catch (error) {
      if (/No such (object|container|volume)/i.test(String((error as { stderr?: string }).stderr))) continue;
      throw failure('Could not verify project runtime resources for removal.');
    }
    const labels = kind === 'container' ? metadata.Config.Labels : metadata.Labels;
    if (labels?.['cloudcli.project-id'] !== project.project_id) throw failure('Runtime resource ownership mismatch.');
    await executeIsolationDocker(kind === 'container' ? ['rm', '-f', resource] : ['volume', 'rm', resource]);
  }
}
