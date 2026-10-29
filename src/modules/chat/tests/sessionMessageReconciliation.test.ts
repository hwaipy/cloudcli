import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('replaces a Codex Steer echo with its persisted input after a delayed history write', () => {
  const steer = createUserMessage('steer_live', '2026-10-29T14:22:35.982Z', {
    provider: 'codex', content: 'tigerVNC？',
  });
  const persisted = createUserMessage('codex_history', '2026-10-29T14:26:04.316Z', {
    provider: 'codex', content: 'tigerVNC？',
  });
  const muchLater = { ...persisted, timestamp: '2026-10-29T14:30:36.000Z' };

  assert.deepEqual(removeOptimisticUserEchoes([], [steer]), [steer]);
  assert.deepEqual(removeOptimisticUserEchoes([persisted], [steer]), []);
  assert.deepEqual(removeOptimisticUserEchoes([muchLater], [steer]), []);
});

test('matches repeated Codex Steer text one-to-one without dropping a separate input', () => {
  const first = createUserMessage('steer_first', '2026-10-29T14:22:23.000Z', {
    provider: 'codex', content: 'repeat',
  });
  const second = createUserMessage('steer_second', '2026-10-29T14:22:35.000Z', {
    provider: 'codex', content: 'repeat',
  });
  const firstHistory = createUserMessage('codex_first', '2026-10-29T14:26:04.313Z', {
    provider: 'codex', content: 'repeat',
  });
  const secondHistory = createUserMessage('codex_second', '2026-10-29T14:26:04.316Z', {
    provider: 'codex', content: 'repeat',
  });

  assert.deepEqual(removeOptimisticUserEchoes([firstHistory], [first, second]), [second]);
  assert.deepEqual(removeOptimisticUserEchoes([firstHistory, secondHistory], [first, second]), []);
});

test('Steer reconciliation ignores older, cross-session, and cross-provider lookalikes', () => {
  const steer = createUserMessage('steer_live', '2026-10-29T14:22:35.000Z', {
    provider: 'codex', content: 'repeat',
  });
  const old = createUserMessage('codex_old', '2026-10-29T14:20:00.000Z', {
    provider: 'codex', content: 'repeat',
  });
  const otherSession = createUserMessage('codex_other', '2026-10-29T14:26:00.000Z', {
    provider: 'codex', sessionId: 'session-2', content: 'repeat',
  });
  const otherProvider = createUserMessage('claude_other', '2026-10-29T14:26:00.000Z', {
    content: 'repeat',
  });

  assert.deepEqual(removeOptimisticUserEchoes([old, otherSession, otherProvider], [steer]), [steer]);
});

test('only Codex user text with a Steer identity participates in Steer reconciliation', () => {
  const history = createUserMessage('codex_history', '2026-10-29T14:26:00.000Z', {
    provider: 'codex', content: 'repeat',
  });
  const assistant = { ...history, id: 'steer_assistant', role: 'assistant' as const };
  const unrelated = { ...history, id: 'other_live', timestamp: '2026-10-29T14:22:00.000Z' };

  assert.deepEqual(removeOptimisticUserEchoes([history], [assistant, unrelated]), [assistant, unrelated]);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});
