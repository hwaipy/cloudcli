import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';

import { prepareContainerSshTools } from './isolation-ssh-initialization.service.js';
import { startIsolationEgress } from './egress-proxy.service.js';
import { executeIsolationDocker, spawnIsolationDocker } from './isolation-docker.service.js';

const preparedContainers = new Set<string>();
const MAX_AGENT_PACKET = 256 * 1024;

function allowedAgentRequest(payload: Buffer): boolean {
  const type = payload[0];
  if (type === 11) return payload.length === 1; // SSH2_AGENTC_REQUEST_IDENTITIES
  let offset = 1;
  const field = (): Buffer | null => {
    if (offset + 4 > payload.length) return null;
    const length = payload.readUInt32BE(offset); offset += 4;
    if (offset + length > payload.length) return null;
    const value = payload.subarray(offset, offset + length); offset += length; return value;
  };
  if (type === 13) return Boolean(field() && field() && offset + 4 === payload.length); // SSH2_AGENTC_SIGN_REQUEST
  if (type === 27) {
    const name = field();
    return name?.toString() === 'session-bind@openssh.com' && Boolean(field() && field() && field() && offset + 1 === payload.length);
  }
  return false; // Never forward add/remove identity, lock/unlock or other agent management operations.
}

/** Used by the SSH broker and its protocol tests to expose only key listing, signing and OpenSSH session binding. No private key bytes or request contents are logged. */
export async function startIsolationSshAgent(socketPath: string, targetAgent: string): Promise<net.Server> {
  if (!path.isAbsolute(targetAgent) || targetAgent === socketPath || !(await fs.stat(targetAgent)).isSocket()) throw new Error('A local SSH agent socket is required');
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const existing = await fs.lstat(socketPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (!existing.isSocket()) throw new Error('SSH relay path is not a socket');
    const active = await new Promise<boolean>((resolve) => {
      const probe = net.connect(socketPath); probe.setTimeout(500);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('timeout', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => { probe.destroy(); resolve(false); });
    });
    if (active) throw new Error('Another SSH relay owns this socket');
    await fs.rm(socketPath);
  }
  const server = net.createServer((client) => {
    const upstream = net.connect(targetAgent);
    let buffered = Buffer.alloc(0);
    const filter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (!length || length > MAX_AGENT_PACKET) { callback(new Error('Invalid SSH agent frame')); return; }
          if (buffered.length < length + 4) break;
          const packet = buffered.subarray(0, length + 4);
          if (!allowedAgentRequest(packet.subarray(4))) { callback(new Error('SSH agent operation is not permitted')); return; }
          this.push(packet); buffered = buffered.subarray(length + 4);
        }
        callback();
      },
      flush(callback) { callback(buffered.length ? new Error('Incomplete SSH agent frame') : undefined); },
    });
    const close = () => { client.destroy(); upstream.destroy(); filter.destroy(); };
    client.setTimeout(5 * 60_000, close); upstream.setTimeout(5 * 60_000, close);
    client.on('error', close); upstream.on('error', close); filter.on('error', close);
    client.on('close', close); upstream.on('close', close);
    client.pipe(filter).pipe(upstream); upstream.pipe(client);
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  return server;
}

/** Used by the standalone systemd SSH broker, allowing the backend to restart independently of agent and public SSH forwarding. */
export async function startIsolationSshBroker(stateRoot: string, targetAgent: string) {
  const directory = path.join(stateRoot, '.egress');
  const agent = await startIsolationSshAgent(path.join(directory, 'ssh-agent.sock'), targetAgent);
  try {
    const proxy = await startIsolationEgress(path.join(directory, 'ssh-proxy.sock'), { allowSsh: true });
    return { agent, proxy };
  } catch (error) { agent.close(); throw error; }
}

const SSH_PROXY_COMMAND = String.raw`const net=require('net');const host=process.argv[2],port=Number(process.argv[3]);if(!host||!(/^[a-zA-Z0-9_.:\[\]-]+$/).test(host)||!Number.isInteger(port)||port<1||port>65535)process.exit(2);const authority=(host.includes(':')?'['+host.replace(/^\[|\]$/g,'')+']':host)+':'+port;const socket=net.connect('/run/cloudcli-egress/ssh-proxy.sock');socket.setTimeout(30000,()=>socket.destroy(new Error('SSH proxy timeout')));socket.on('error',()=>{process.stderr.write('Isolated SSH connection failed\n');process.exitCode=1});socket.on('connect',()=>socket.write('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n\r\n'));let header=Buffer.alloc(0);function handshake(chunk){header=Buffer.concat([header,chunk]);const end=header.indexOf('\r\n\r\n');if(end<0){if(header.length>8192)socket.destroy();return}if(!/^HTTP\/1\.[01] 200 /.test(header.subarray(0,end).toString())){socket.destroy(new Error('SSH egress denied'));return}socket.removeListener('data',handshake);socket.setTimeout(0);const rest=header.subarray(end+4);if(rest.length)process.stdout.write(rest);socket.pipe(process.stdout);process.stdin.pipe(socket)}socket.on('data',handshake);socket.on('close',()=>{process.stdin.destroy()});`;

/** Used by project startup and the broker's initial adoption of existing containers; writes only managed public socket/proxy configuration into the private writable system layer. */
export async function configureContainerSshAccess(container: string): Promise<void> {
  await prepareContainerSshTools(container);
  const files = {
    '/opt/cloudcli/ssh-proxy.cjs': SSH_PROXY_COMMAND,
    '/etc/profile.d/cloudcli-ssh-agent.sh': 'export SSH_AUTH_SOCK=/run/cloudcli-egress/ssh-agent.sock\n',
    '/etc/ssh/ssh_config.d/90-cloudcli-isolation.conf': 'Host *\n  IdentityAgent /run/cloudcli-egress/ssh-agent.sock\n  ProxyCommand /usr/local/bin/node /opt/cloudcli/ssh-proxy.cjs %h %p\n',
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawnIsolationDocker(['exec', '-i', container, '/usr/local/bin/node', '-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const fs=require('fs'),p=require('path');for(const [file,body] of Object.entries(JSON.parse(input))){fs.mkdirSync(p.dirname(file),{recursive:true});if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==body)fs.writeFileSync(file,body,{mode:0o644})}});`]);
    child.once('error', reject); child.stdin.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Cannot configure isolated SSH access')));
    child.stdin.end(JSON.stringify(files));
  });
}

/** Used by the broker at startup to enable existing running strict containers without rebuilding their installed software. */
export async function configureRunningIsolationSsh(stateRoot: string): Promise<void> {
  const { stdout } = await executeIsolationDocker(['ps', '-q', '--filter', 'label=cloudcli.isolation-policy=2']);
  const running = stdout.trim().split(/\s+/).filter(Boolean);
  for (const id of preparedContainers) if (!running.includes(id)) preparedContainers.delete(id);
  for (const id of running) {
    if (preparedContainers.has(id)) continue;
    const container = JSON.parse((await executeIsolationDocker(['inspect', id])).stdout)[0];
    if (container.Config.Labels?.['cloudcli.isolation-policy'] !== '2' || !container.Mounts?.some((mount: { Source: string; Destination: string; RW: boolean }) => mount.Source === path.join(stateRoot, '.egress') && mount.Destination === '/run/cloudcli-egress' && !mount.RW)) continue;
    try { await configureContainerSshAccess(id); preparedContainers.add(id); } catch { console.warn('Could not prepare one existing isolated SSH client; project startup will retry.'); }
  }
}
