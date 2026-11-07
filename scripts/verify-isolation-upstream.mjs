#!/usr/bin/env node
// Disposable network-none Rootless container, using deployed egress code. No business messages or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-upstream-check-'));
const container = `cloudcli-upstream-check-${randomUUID()}`;
const dockerHost = process.env.CLOUDCLI_ISOLATION_DOCKER_HOST || `unix:///run/user/${process.getuid()}/docker.sock`;
const docker = (args, options = {}) => execute('docker', ['--host', dockerHost, ...args], { timeout: 90000, maxBuffer: 1024 * 1024, ...options });
const { startIsolationEgress } = await import(pathToFileURL(path.resolve(process.argv[2] || 'dist-server', 'server/modules/project-isolation/egress-proxy.service.js')).href);
let proxy;
try {
  assert.ok(process.env.CLOUDCLI_ISOLATION_UPSTREAM_PROXY, 'Set the operator upstream proxy');
  const egress = path.join(work, 'egress');
  proxy = await startIsolationEgress(path.join(egress, 'proxy.sock'));
  await docker(['run', '-d', '--name', container, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64', '--mount', `type=bind,src=${egress},dst=/run/cloudcli-egress,readonly`, process.env.ISOLATION_VERIFY_IMAGE || 'cloudcli-codex-isolated:v2-0.166.0']);
  await new Promise((r) => setTimeout(r, 1000));
  const inspect = JSON.parse((await docker(['inspect', container])).stdout)[0];
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.Mounts.length, 1);
  for (const relative of ['', '_static/styles/pydata-sphinx-theme.css', '_static/pygments.css', 'pages/1.%20Atomic%20Polarizability.html']) {
    const url = 'https://byucamacholab.github.io/nonlinear-optics/' + relative;
    const result = await docker(['exec', container, 'curl', '--fail', '--silent', '--show-error', '--retry', '1', '--connect-timeout', '15', '--max-time', '30', '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{time_total}', url]);
    assert.match(result.stdout, /^200 /);
    console.log('RESOURCE_OK', relative || '(index)', result.stdout);
  }
  for (const url of ['http://127.0.0.1/', 'http://192.168.5.2/', 'http://169.254.169.254/']) {
    const result = await docker(['exec', container, 'curl', '-sS', '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', url]);
    assert.equal(result.stdout, '403');
    console.log('PRIVATE_TARGET_DENIED', url);
  }
  console.log('ROOTLESS_NETWORK_NONE_UPSTREAM_VERIFIED');
} finally {
  await docker(['rm', '-f', '-v', container]).catch(() => {});
  if (proxy) await new Promise((r) => proxy.close(() => r()));
  await fs.rm(work, { recursive: true, force: true });
}
