#!/usr/bin/env node
// Synthetic migration fixture only. Never touches a production project or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const id = randomUUID(), volume = `cloudcli-codex-state-${id}`, name = `cloudcli-isolated-${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-rootless-migration-'));
const legacy = (args) => execute('docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
const isolated = (args) => execute('docker', ['--host', `unix:///run/user/${process.getuid()}/docker.sock`, ...args]);
const { importLegacyIsolation } = await import(pathToFileURL(path.resolve(process.argv[2] || 'dist-server', 'server/modules/project-isolation/isolation-migration.service.js')).href);
const oldImage = process.env.ISOLATION_VERIFY_LEGACY_IMAGE || 'cloudcli-codex-isolated:v1-0.166.0';
const newImage = process.env.ISOLATION_VERIFY_IMAGE || 'cloudcli-codex-isolated:v2-0.166.0';
try {
  await legacy(['volume', 'create', '--label', `cloudcli.project-id=${id}`, volume]);
  await legacy(['run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/state`, '--entrypoint', 'sh', oldImage, '-c', `mkdir -p /state/sessions; dd if=/dev/urandom of=/state/archive-payload bs=1048576 count=8 status=none; printf 'PRIVATE_SYNTHETIC_HISTORY' > /state/sessions/probe.jsonl; printf 'SYNTHETIC_AUTH' > /state/auth.json; chown -R ${process.getuid()}:${process.getgid()} /state; chmod 700 /state; chmod 600 /state/auth.json`]);
  await legacy(['create', '--name', name, '--read-only', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`, '--label', `cloudcli.project-id=${id}`, '--label', 'cloudcli.isolation-policy=1', '--mount', `type=bind,src=${root},dst=${root}`, '--mount', `type=volume,src=${volume},dst=/state`, '--entrypoint', 'sleep', oldImage, 'infinity']);
  await legacy(['start', name]);
  await isolated(['volume', 'create', '--label', `cloudcli.project-id=${id}`, volume]);
  assert.equal(await importLegacyIsolation({ project_id: id, project_path: root }, newImage, volume, true), true);
  const source = JSON.parse((await legacy(['inspect', name])).stdout)[0];
  assert.equal(source.State.Running, false);
  const result = await isolated(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--read-only', '--mount', `type=volume,src=${volume},dst=/state,readonly`, '--entrypoint', 'node', newImage, '-e', "const fs=require('fs');if(fs.readFileSync('/state/auth.json','utf8')!=='SYNTHETIC_AUTH'||fs.readFileSync('/state/sessions/probe.jsonl','utf8')!=='PRIVATE_SYNTHETIC_HISTORY'||fs.statSync('/state/auth.json').uid!==0||fs.statSync('/state/archive-payload').size!==8*1048576)process.exit(1);console.log('LEGACY_PRIVATE_VOLUME_MIGRATION_OK')"]);
  console.log(result.stdout.trim());
  console.log('STOPPED_LEGACY_ROLLBACK_COPY_PRESERVED_OK');
} finally {
  await legacy(['rm', '-f', name]).catch(() => {});
  await legacy(['volume', 'rm', volume]).catch(() => {});
  await isolated(['volume', 'rm', volume]).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
