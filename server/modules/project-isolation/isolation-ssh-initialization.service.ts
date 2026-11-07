import { AppError } from '@/shared/utils.js';
import { executeIsolationDocker } from './isolation-docker.service.js';

const PROXY_READY_SCRIPT = String.raw`const net=require("net");const end=Date.now()+30000;function probe(){const s=net.connect(18080,"127.0.0.1");let done=false;function finish(ok){if(done)return;done=true;s.destroy();if(ok)process.exit(0);if(Date.now()>=end){console.error("CLOUDCLI_PROXY_NOT_READY");process.exit(71)}setTimeout(probe,200)}s.setTimeout(500,()=>finish(false));s.once("error",()=>finish(false));s.once("connect",()=>finish(true))}probe()`;

// flock is supplied by Debian util-linux. Holding it across the second tool
// check, readiness and apt also coordinates the independent SSH broker process.
const PREPARE_SCRIPT = String.raw`
set -eu
command -v flock >/dev/null || { echo CLOUDCLI_SSH_LOCK_UNAVAILABLE >&2; exit 70; }
flock -w 180 /tmp/cloudcli-ssh-initialization.lock sh -eu -c '
  command -v ssh >/dev/null && command -v ssh-add >/dev/null && exit 0
  echo "[isolation-init] stage=proxy-readiness" >&2
  node -e '\''${PROXY_READY_SCRIPT}'\''
  mirror=https://deb.debian.org
  grep -q mirrors.tuna.tsinghua.edu.cn /etc/apt/sources.list.d/debian.sources && mirror=https://mirrors.tuna.tsinghua.edu.cn || true
  ready=0
  for attempt in 1 2 3 4 5; do
    if curl --proxy http://127.0.0.1:18080 --noproxy "" --head --fail --silent --show-error --connect-timeout 2 --max-time 4 "$mirror/debian/dists/bookworm/InRelease" >/dev/null; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ] || { echo CLOUDCLI_PROXY_UPSTREAM_UNAVAILABLE >&2; exit 72; }
  echo "[isolation-init] stage=ssh-install" >&2
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=1 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any update &&
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=1 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y --no-install-recommends openssh-client || { echo CLOUDCLI_SSH_INSTALL_FAILED >&2; exit 73; }
  command -v ssh >/dev/null && command -v ssh-add >/dev/null
'
`;

/** Project startup and the standalone SSH broker share this bounded, container-locked legacy initialization. No model input is sent here. */
export async function prepareContainerSshTools(container: string): Promise<void> {
  const started = Date.now();
  try {
    await executeIsolationDocker(['exec', '-e', 'DEBIAN_FRONTEND=noninteractive', container, 'sh', '-c', PREPARE_SCRIPT], { timeout: 420_000, maxBuffer: 4 * 1024 * 1024 });
    console.info('[IsolationInit] SSH tools ready', { container, elapsedMs: Date.now() - started });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    const code = stderr.includes('CLOUDCLI_PROXY_NOT_READY') ? 'ISOLATION_PROXY_NOT_READY'
      : stderr.includes('CLOUDCLI_PROXY_UPSTREAM_UNAVAILABLE') ? 'ISOLATION_PROXY_UPSTREAM_UNAVAILABLE'
        : stderr.includes('CLOUDCLI_SSH_LOCK_UNAVAILABLE') ? 'ISOLATION_SSH_LOCK_UNAVAILABLE' : 'ISOLATION_SSH_INSTALL_FAILED';
    console.warn('[IsolationInit] SSH preparation failed', { container, code, elapsedMs: Date.now() - started });
    throw new AppError(`项目环境初始化失败（${code}），请稍后在此会话重试。尚未提交 Codex 输入。`, { code, statusCode: 503 });
  }
}

/** Project startup waits for the local forwarder before any Codex network request, even when SSH is preinstalled. */
export async function waitForContainerProxy(container: string): Promise<void> {
  try {
    await executeIsolationDocker(['exec', container, 'node', '-e', PROXY_READY_SCRIPT], { timeout: 35_000 });
  } catch {
    throw new AppError('项目环境初始化失败：出口代理尚未就绪，请稍后在此会话重试。尚未提交 Codex 输入。', { code: 'ISOLATION_PROXY_NOT_READY', statusCode: 503 });
  }
}
