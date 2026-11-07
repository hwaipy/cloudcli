import { expect, test } from 'vitest';

import { withRoundForkAnchors } from '@/modules/chat/utils/roundForkAnchors';
import type { ChatMessage } from '@/shared/types';
const user = (anchor?: string): ChatMessage => ({ type: 'user', content: 'prompt', transcriptAnchorId: anchor, timestamp: 1 });
const answer = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({ type: 'assistant', content: 'reply', timestamp: 2, ...overrides });

test('Codex fork is attached to the completed final answer, using its inclusive native turn boundary', () => {
  const source = [user('turn-1'), answer({ codexPhase: 'commentary' }), answer({ isThinking: true }), answer({ codexPhase: 'final_answer' })];
  const result = withRoundForkAnchors(source, 'codex', false);
  expect(result.map(message => message.forkAnchorId)).toEqual([undefined, undefined, undefined, 'turn-1']);
  expect(source[3].forkAnchorId).toBeUndefined();
  expect(withRoundForkAnchors(source, 'codex', true).every(message => !message.forkAnchorId)).toBe(true);
});

test('Steer retains the current Codex turn, while an unanchored new turn cannot inherit an old boundary', () => {
  const result = withRoundForkAnchors([user('turn-1'), user(), answer({ codexPhase: 'final_answer' }), user(), answer({ codexPhase: 'final_answer' })], 'codex', false);
  expect(result.map(message => message.forkAnchorId)).toEqual([undefined, undefined, 'turn-1', undefined, undefined]);
});

test('Claude uses the last assistant UUID, keeping the answer rather than only the prompt', () => {
  const result = withRoundForkAnchors([user('user-1'), answer({ transcriptAnchorId: 'assistant-1' }), answer({ transcriptAnchorId: 'assistant-2' }), user('user-2'), answer({ isStreaming: true })], 'claude', true);
  expect(result.map(message => message.forkAnchorId)).toEqual([undefined, undefined, 'assistant-2', undefined, undefined]);
});
