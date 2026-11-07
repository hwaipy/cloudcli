import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

import type { AnyRecord, ProjectRepositoryRow } from '@/shared/types.js';

import { isolationDockerArgs, executeIsolationDocker } from './isolation-docker.service.js';

const execute = promisify(execFile);

/** Used by first Rootless launch after the previous backend has exited; copies only the old private volume and keeps its original container/volume as a stopped rollback copy. */
export async function importLegacyIsolation(project: ProjectRepositoryRow, image: string, volume: string, previousCredentials: boolean): Promise<boolean> {
  const legacyHost = process.env.CLOUDCLI_ISOLATION_LEGACY_DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (!/^unix:\/\/\//.test(legacyHost) || /[\r\n\0]/.test(legacyHost)) throw new Error('Invalid legacy Docker endpoint');
  let legacy: AnyRecord;
  try {
    legacy = JSON.parse((await execute('docker', ['--host', legacyHost, 'inspect', `cloudcli-isolated-${project.project_id}`], { timeout: 10_000 })).stdout)[0];
  } catch {
    if (previousCredentials) throw new Error('Existing isolation credentials have no Rootless volume. Make the legacy Docker daemon available to migrate history; no empty replacement was created.');
    return false;
  }
  if (legacy.Config.Labels?.['cloudcli.project-id'] !== project.project_id || legacy.Config.Labels?.['cloudcli.isolation-policy'] !== '1'
    || !legacy.HostConfig.ReadonlyRootfs || legacy.HostConfig.Privileged || legacy.HostConfig.NetworkMode !== 'none'
    || !legacy.Mounts?.some((mount: AnyRecord) => mount.Type === 'bind' && mount.Source === project.project_path && mount.Destination === project.project_path)
    || !legacy.Mounts?.some((mount: AnyRecord) => mount.Type === 'volume' && mount.Name === volume)) {
    throw new Error('Legacy container ownership or policy does not match; migration stopped.');
  }
  if (legacy.State.Running) await execute('docker', ['--host', legacyHost, 'stop', '--time', '5', legacy.Name], { timeout: 15_000 });
  // No workspace, authentication, network, Docker socket or host state bind is exposed to these copy helpers.
  const suffix = `${project.project_id}-${randomUUID().slice(0, 8)}`;
  const readerName = `cloudcli-migration-reader-${suffix}`;
  const writerName = `cloudcli-migration-writer-${suffix}`;
  const reader = spawn('docker', ['--host', legacyHost, 'run', '--rm', '--name', readerName, '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', legacy.Config.User,
    '--mount', `type=volume,src=${volume},dst=/state,readonly`, '--entrypoint', 'tar', legacy.Image, '-C', '/state', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // GNU tar may finish before consuming archive padding. Drain stdin afterward so
  // Docker does not close its attach stream while Node is still piping the tail.
  const writer = spawn('docker', isolationDockerArgs(['run', '--rm', '--name', writerName, '-i', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--user', '0:0',
    '--mount', `type=volume,src=${volume},dst=/state`, '--entrypoint', 'sh', image, '-c', 'umask 077; tar -C /state --no-same-owner --no-same-permissions -xf -; result=$?; cat >/dev/null; exit "$result"']), { stdio: ['pipe', 'ignore', 'pipe'] });
  const complete = (child: ChildProcess, stage: string) => new Promise<void>((resolve, reject) => {
    child.stderr?.resume(); // Never log private archive contents or credential filenames.
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Private isolation volume migration ${stage} failed (exit ${code ?? 'signal'}).`)));
  });
  const timeout = setTimeout(() => { reader.kill(); writer.kill(); }, 120_000);
  try { await Promise.all([complete(reader, 'export'), complete(writer, 'import'), pipeline(reader.stdout!, writer.stdin!)]); }
  catch (error) {
    throw new Error('Private isolation volume migration did not complete. The original data is retained; retry after checking the migration service.', { cause: error });
  } finally {
    clearTimeout(timeout);
    if (reader.exitCode === null) reader.kill();
    if (writer.exitCode === null) writer.kill();
    // Killing a Docker CLI does not guarantee its helper container is stopped.
    // Wait for removal before the caller can discard an incomplete destination volume.
    await Promise.allSettled([
      execute('docker', ['--host', legacyHost, 'rm', '-f', readerName], { timeout: 15_000 }),
      executeIsolationDocker(['rm', '-f', writerName], { timeout: 15_000 }),
    ]);
  }
  return true;
}
