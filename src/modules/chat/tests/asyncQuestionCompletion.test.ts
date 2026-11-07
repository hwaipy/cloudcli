import { expect, test } from 'vitest';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { NormalizedMessage } from '@/shared/types';
const question = (id: string) => ({ id, kind: 'text', role: 'assistant', provider: 'codex', content: 'Pick?', codexQuestions: [{ title: 'Pick?', options: ['Yes', 'No'] }] } as NormalizedMessage);
const reply = { id: 'reply', kind: 'text', role: 'user', provider: 'codex', content: '回答「Pick?」：Yes' } as NormalizedMessage;
test('reloaded acknowledged user replies complete only the nearest matching question without changing cached input', () => {
  const first = question('first'), second = question('second');
  const rows = normalizedToChatMessages([first, second, reply]);
  expect(rows).toHaveLength(2);
  expect((rows[0].codexQuestions as any[])[0].answered).toBeUndefined();
  expect((rows[1].codexQuestions as any[])[0]).toMatchObject({ answered: true, answer: 'Yes' });
  expect((second.codexQuestions as any[])[0].answered).toBeUndefined();
});
test('an unanswered question stays interactive until an actual reply arrives', () => {
  expect((normalizedToChatMessages([question('first')])[0].codexQuestions as any[])[0].answered).toBeUndefined();
});
test('question folding preserves unrelated prose and never hides answers whose question is outside loaded history', () => {
  const mixed = { ...reply, content: '回答「Pick?」：Yes\nAlso keep this instruction' };
  const rows = normalizedToChatMessages([question('first'), mixed]);
  expect(rows).toHaveLength(2);
  expect(rows[1].content).toBe('Also keep this instruction');
  expect(normalizedToChatMessages([reply])[0].content).toBe(reply.content);
});
test('removing a reply restores the unanswered question without stale projection state', () => {
  const first = question('same-cached-row');
  normalizedToChatMessages([first, reply]);
  expect((normalizedToChatMessages([first])[0].codexQuestions as any[])[0].answered).toBeUndefined();
});
