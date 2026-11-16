import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexUserInputRequests } from '@/modules/providers/list/codex/codex-user-input.service.js';
import type { ProviderRuntimeWriter } from '@/shared/index.js';

test('new Codex questions notify the owner once without exposing prompt or secret answer', () => {
  const notifications: any[] = []; const messages: any[] = [];
  const questions = new CodexUserInputRequests(event => { notifications.push(event); });
  const writer = { userId: 7, isWebSocketWriter: true, send: (value: unknown) => messages.push(value) } as ProviderRuntimeWriter;
  const params = { itemId: 'question-1', questions: [{ id: 'one', question: 'private prompt', isSecret: true, options: [] }] };
  assert.equal(questions.receive('session', 1, params, writer, () => {}), true);
  questions.receive('session', 1, params, writer, () => {});
  assert.equal(notifications.length, 1); assert.equal(notifications[0].userId, 7);
  assert.equal(notifications[0].event.code, 'permission.required');
  assert.ok(!JSON.stringify(notifications).includes('private prompt'));
  assert.ok(messages.some(message => message.kind === 'permission_request'));
});
test('notification failure never prevents answering; invalid input does not notify', () => {
  const messages: any[] = []; let answer: unknown;
  const questions = new CodexUserInputRequests(() => { throw Error('offline'); });
  const writer = { userId: 7, isWebSocketWriter: true, send: (value: unknown) => messages.push(value) } as ProviderRuntimeWriter;
  assert.equal(questions.receive('session', 1, { questions: [] }, writer, () => {}), false);
  questions.receive('session', 2, { itemId: 'q', questions: [{ id: 'one', question: 'Choice?', options: [] }] }, writer, value => { answer = value; });
  const request = messages.find(message => message.kind === 'permission_request');
  questions.resolve(request.requestId, { allow: true, updatedInput: { answers: { one: 'yes' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), { answers: { one: { answers: ['yes'] } } });
});
