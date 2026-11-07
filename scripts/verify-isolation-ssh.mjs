#!/usr/bin/env node
// Disposable Rootless container. Reads public keys and tests agent signing;
// never modifies host identities and never sends credentials to a remote server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
// Require an explicitly approved probe destination, never a developer's server.
const destination=process.env.ISOLATION_VERIFY_SSH_DESTINATION;
assert.ok(destination && !destination.startsWith('-') && !/\s/.test(destination), 'Set ISOLATION_VERIFY_SSH_DESTINATION to an approved SSH destination');
const work=await fs.mkdtemp(path.join(os.tmpdir(),'cloudcli-ssh-verify-'));
const host=process.env.CLOUDCLI_ISOLATION_DOCKER_HOST||`unix:///run/user/${process.getuid()}/docker.sock`;
const docker=(args,options={})=>execute('docker',['--host',host,...args],{timeout:30000,maxBuffer:4*1024*1024,...options});
const image=process.env.ISOLATION_VERIFY_IMAGE||'cloudcli-codex-isolated:v2-0.166.0';
const container='cloudcli-ssh-verification-'+randomUUID();
const source=process.env.CLOUDCLI_ISOLATION_SSH_AUTH_SOCK||'/run/host-services/ssh-auth.sock';
const moduleRoot=path.resolve(process.argv[2]||'dist-server','server/modules/project-isolation');
const {startIsolationSshBroker,configureContainerSshAccess}=await import(pathToFileURL(path.join(moduleRoot,'isolation-ssh.service.js')).href);
let broker;
try {
  await fs.mkdir(path.join(work,'project'));
  const publicKeys=(await execute('ssh-add',['-L'],{env:{...process.env,SSH_AUTH_SOCK:source}})).stdout;
  assert.ok(publicKeys.trim()); await fs.writeFile(path.join(work,'project/probe.pub'),publicKeys.split('\n')[0]+'\n',{mode:0o600});
  broker=await startIsolationSshBroker(path.join(work,'state'),source);
  await fs.symlink('ssh-proxy.sock',path.join(work,'state/.egress/proxy.sock'));
  await docker(['run','-d','--name',container,'--network','none','--cap-drop','ALL',...['CHOWN','DAC_OVERRIDE','FOWNER','FSETID','SETUID','SETGID','SETFCAP','KILL'].flatMap(c=>['--cap-add',c]),'--security-opt','no-new-privileges','--memory','2g','--pids-limit','256','--mount',`type=bind,src=${work}/project,dst=/workspace`,'--mount',`type=bind,src=${work}/state/.egress,dst=/run/cloudcli-egress,readonly`,image]);
  await configureContainerSshAccess(container);
  await docker(['exec',container,'node','--check','/opt/cloudcli/ssh-proxy.cjs']);
  const listed=(await docker(['exec','-e','SSH_AUTH_SOCK=/run/cloudcli-egress/ssh-agent.sock',container,'ssh-add','-L'])).stdout;
  assert.equal(listed,publicKeys);console.log('CONTAINER_HOST_AGENT_IDENTITIES_MATCH');
  await docker(['exec','-e','SSH_AUTH_SOCK=/run/cloudcli-egress/ssh-agent.sock',container,'ssh-add','-T','/workspace/probe.pub']);
  console.log('CONTAINER_REAL_HOST_KEY_SIGNING_OK');
  const config=(await docker(['exec',container,'ssh','-G','example.com'])).stdout;
  assert.match(config,/identityagent \/run\/cloudcli-egress\/ssh-agent.sock/);assert.match(config,/proxycommand .*ssh-proxy.cjs/);
  console.log('SSH_CONFIG_ROUTES_AGENT_AND_NETWORK_OK');
  let denied=false;try {await docker(['exec',container,'node','/opt/cloudcli/ssh-proxy.cjs','127.0.0.1','22']);}catch{denied=true;}assert.ok(denied);
  console.log('PRIVATE_SSH_DESTINATION_DENIED');
  await docker(['exec',container,'node','-e',`const fs=require('fs');for(const p of [${JSON.stringify(path.join(os.homedir(),'.ssh'))},'/run/host-services/ssh-auth.sock','/var/run/docker.sock'])if(fs.existsSync(p))throw Error('Unexpected host resource');`]);
  console.log('HOST_PRIVATE_KEY_FILES_AND_DOCKER_SOCKET_NOT_MOUNTED');
  // Verify the SSH protocol reaches a public server but stop at host verification,
  // before the client can offer any authentication identity to that server.
  const greeting=await docker(['exec',container,'ssh','-v','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/dev/null','-o','GlobalKnownHostsFile=/dev/null','-o','ConnectTimeout=15','-p',process.env.ISOLATION_VERIFY_SSH_PORT||'223','-T',destination],{timeout:20000}).catch(error=>({stdout:error.stdout||'',stderr:error.stderr||''}));
  if(!/Remote protocol version 2\.0/.test(greeting.stderr))console.log('PUBLIC_SSH_DIAGNOSTIC',greeting.stderr.slice(-1800));
  assert.match(greeting.stderr,/Remote protocol version 2\.0/,'Public SSH should reach host-key verification without authenticating');
  assert.match(greeting.stderr,/Host key verification failed/);
  console.log('CUSTOM_PORT_SSH_HANDSHAKE_AND_HOST_VERIFICATION_ENFORCED_OK');
  console.log('ISOLATION_SSH_VERIFICATION_OK');
} finally {
  await docker(['rm','-f',container]).catch(()=>{});
  if(broker){broker.agent.close();broker.proxy.close();}
  await fs.rm(work,{recursive:true,force:true});
}
