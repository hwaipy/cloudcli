import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAutoTitleService } from '@/modules/providers/services/session-auto-title.service.js';

test('AI title updates only the expected temporary name and broadcasts once', async () => {
  const writes: string[][]=[];const events:string[]=[];
  const service=createSessionAutoTitleService({generate:async()=> '实验室管理需求',apply:(...args)=>{writes.push(args);return true;},broadcast:async id=>{events.push(id);}});
  await service.schedule('s1','codex','帮我整理实验室管理系统需求','帮我整理实验室管理系统需求');
  assert.deepEqual(writes,[['s1','帮我整理实验室管理系统需求','实验室管理需求']]);
  assert.deepEqual(events,['s1']);
});

test('manual rename cancels an in-flight AI title even if the user restores the temporary name', async () => {
  let finish!: (title:string)=>void; let writes=0;
  const service=createSessionAutoTitleService({generate:()=>new Promise(resolve=>{finish=resolve;}),apply:()=>{writes++;return true;},broadcast:async()=>{assert.fail('manual rename must win');}});
  const pending=service.schedule('s1','claude','hello','hello');
  service.cancel('s1');finish('AI title');await pending;
  assert.equal(writes,0);
});

test('changed or deleted sessions, generation failures and empty input preserve the original title', async () => {
  let broadcasts=0;
  const service=createSessionAutoTitleService({generate:async()=> 'Title',apply:()=>false,broadcast:async()=>{broadcasts++;}});
  await service.schedule('s1','codex','hello','hello');
  assert.equal(broadcasts,0);
  const failed=createSessionAutoTitleService({generate:async()=>{throw Error('upstream unavailable');},apply:()=>{assert.fail('must not update');}});
  await failed.schedule('s2','claude','hello','hello');
  await failed.schedule('s3','claude','','Untitled Session');
});

test('title inference stays bounded while cancelled requests finish and duplicate jobs are ignored', async () => {
  const finish:Array<(value:string)=>void>=[];let calls=0;
  const service=createSessionAutoTitleService({generate:()=>{calls++;return new Promise(resolve=>finish.push(resolve));},apply:()=>false});
  const tasks=Array.from({length:4},(_,i)=>service.schedule('s'+i,'codex','text','text'));
  await service.schedule('s0','codex','text','text');
  service.cancel('s0');await service.schedule('excess','codex','text','text');
  assert.equal(calls,4);finish.forEach(done=>done('Title'));await Promise.all(tasks);
});
