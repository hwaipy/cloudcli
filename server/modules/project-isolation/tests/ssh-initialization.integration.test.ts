import assert from 'node:assert/strict';
import test from 'node:test';

import { executeIsolationDocker } from '@/modules/project-isolation/isolation-docker.service.js';
import { prepareContainerSshTools } from '@/modules/project-isolation/isolation-ssh-initialization.service.js';

// Explicit opt-in: this creates only a disposable, credential-free container
// and uses an operator-specified existing outbound proxy directory.
test('cold SSH initialization waits, times out, recovers and coordinates concurrent processes', {
  skip: !process.env.CLOUDCLI_ISOLATION_TEST_EGRESS_DIR || !process.env.CLOUDCLI_ISOLATION_TEST_LEGACY_IMAGE,
  timeout: 420_000,
}, async () => {
  const name = `cloudcli-ssh-init-test-${process.pid}-${Date.now()}`;
  try {
    await executeIsolationDocker(['run', '-d', '--name', name, '--network', 'none', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,src=${process.env.CLOUDCLI_ISOLATION_TEST_EGRESS_DIR},dst=/run/cloudcli-egress,readonly`,
      '--entrypoint', 'node', process.env.CLOUDCLI_ISOLATION_TEST_LEGACY_IMAGE!, '-e', 'setInterval(()=>{},1000)']);
    const started = Date.now();
    await assert.rejects(prepareContainerSshTools(name), { code: 'ISOLATION_PROXY_NOT_READY' });
    assert.ok(Date.now() - started >= 29_000 && Date.now() - started < 45_000);
    await executeIsolationDocker(['exec', '-d', name, 'node', '-e', "setTimeout(()=>require('/opt/cloudcli/forwarder.cjs'),2000)"]);
    await Promise.all([prepareContainerSshTools(name), prepareContainerSshTools(name)]);
    await executeIsolationDocker(['exec', name, 'sh', '-c', 'command -v ssh && command -v ssh-add']);
    const history = (await executeIsolationDocker(['exec', name, 'cat', '/var/log/apt/history.log'])).stdout;
    assert.equal(history.split('\n').filter((line) => line.startsWith('Commandline:') && line.includes('install') && line.includes('openssh-client')).length, 1);
    assert.equal((await executeIsolationDocker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', name])).stdout.trim(), 'none');
  } finally {
    await executeIsolationDocker(['rm', '-f', name]).catch(() => {});
  }
});
