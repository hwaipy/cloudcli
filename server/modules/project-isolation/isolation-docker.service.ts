import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Used by the isolation image/runtime adapters to select only their dedicated local daemon, independently of the operator's default Docker context. */
export function isolationDockerArgs(args: string[]): string[] {
  const endpoint = process.env.CLOUDCLI_ISOLATION_DOCKER_HOST || `unix:///run/user/${process.getuid?.() ?? -1}/docker.sock`;
  if (!/^unix:\/\/\//.test(endpoint) || /[\r\n\0]/.test(endpoint)) throw new Error('Strict projects require a local Rootless Docker Unix socket.');
  return ['--host', endpoint, ...args];
}

/** Used by the isolation image/runtime services for bounded Docker requests without altering the user's default context. */
export function executeIsolationDocker(args: string[], options: { timeout?: number; maxBuffer?: number } = {}) {
  return execute('docker', isolationDockerArgs(args), { ...options, encoding: 'utf8' });
}

/** Used by credential/attachment provisioning to keep stdin transfers on the isolation daemon. */
export function spawnIsolationDocker(args: string[]) {
  return spawn('docker', isolationDockerArgs(args), { stdio: ['pipe', 'ignore', 'ignore'] });
}
