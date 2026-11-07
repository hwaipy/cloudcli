import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { CodexAppServerConnection } from '@/modules/providers/list/codex/codex-app-server-connection.provider.js';

test('real stdio RPC preserves string/numeric question IDs while unsupported approvals still fail closed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-question-rpc-'));
  const fixture = path.join(directory, 'fixture.mjs');
  await fs.writeFile(fixture, `import {createInterface} from 'node:readline';
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='fixture/request'){send({id:m.id,result:{}});send({id:m.params.id,method:m.params.method,params:{questions:[]}})}
else if(!m.method)send({method:'fixture/response',params:m});});`);
  const connection = new CodexAppServerConnection({ command: process.execPath, args: [fixture] });
  t.after(async () => { connection.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const responses: Array<Record<string, unknown>> = [];
  connection.subscribe((event) => { if (event.method === 'fixture/response') responses.push(event.params as Record<string, unknown>); }, () => {});
  connection.onRequest((id, method) => {
    if (method !== 'item/tool/requestUserInput') return false;
    connection.respond(id, { answers: { choice: { answers: ['Blue'] } } });
    return true;
  });
  for (const [id, method] of [['question-1', 'item/tool/requestUserInput'], [7, 'item/tool/requestUserInput'], [8, 'item/commandExecution/requestApproval'], [9, 'unhandled/request']] as const) {
    await connection.call('fixture/request', { id, method });
    for (let attempt = 0; attempt < 100 && !responses.some((response) => response.id === id); attempt++) await delay(5);
    const response = responses.find((event) => event.id === id);
    assert.ok(response, `response for ${id}`);
    if (method === 'item/tool/requestUserInput') assert.deepEqual(response.result, { answers: { choice: { answers: ['Blue'] } } });
    else if (id === 8) assert.deepEqual(response.result, { decision: 'decline' });
    else assert.equal((response.error as { code: number }).code, -32601);
  }
});
