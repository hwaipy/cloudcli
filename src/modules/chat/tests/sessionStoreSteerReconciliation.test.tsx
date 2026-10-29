import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

let history: NormalizedMessage[] = [];
const sessionMessages = vi.fn(async (..._args: unknown[]) => ({
  ok: true,
  json: async () => ({ data: { messages: history, total: history.length, hasMore: false } }),
}));

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages: (...args: unknown[]) => sessionMessages(...args) } },
}));

const userRow = (id: string, content: string, timestamp: string): NormalizedMessage => ({
  id, content, timestamp,
  sessionId: 'vnc-session', provider: 'codex', kind: 'text', role: 'user',
});

beforeEach(() => {
  history = [];
  sessionMessages.mockClear();
});

it('keeps two Steer echoes until history arrives, then shows only the persisted inputs', async () => {
  const { result } = renderHook(() => useSessionStore());
  await act(async () => { await result.current.fetchFromServer('vnc-session'); });
  const first = userRow('steer_first', '只输入 key', '2026-10-29T14:22:23.000Z');
  const second = userRow('steer_second', 'tigerVNC？', '2026-10-29T14:22:35.000Z');

  act(() => {
    result.current.appendRealtime('vnc-session', first);
    result.current.appendRealtime('vnc-session', second);
    result.current.appendRealtime('vnc-session', second); // WebSocket replay
  });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['steer_first', 'steer_second']);

  await act(async () => { await result.current.fetchFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['steer_first', 'steer_second']);

  history = [
    userRow('codex_first', first.content ?? '', '2026-10-29T14:26:04.313Z'),
    userRow('codex_second', second.content ?? '', '2026-10-29T14:26:04.316Z'),
  ];
  await act(async () => { await result.current.refreshLatestFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['codex_first', 'codex_second']);

  await act(async () => { await result.current.refreshLatestFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['codex_first', 'codex_second']);

  // Codex history can assign fresh synthetic IDs on every read.
  history = history.map((row) => ({ ...row, id: `${row.id}_new` }));
  await act(async () => { await result.current.refreshLatestFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.content), ['只输入 key', 'tigerVNC？']);
});

it('preserves a second identical Steer until a second historical input exists', async () => {
  const { result } = renderHook(() => useSessionStore());
  await act(async () => { await result.current.fetchFromServer('vnc-session'); });
  const first = userRow('steer_first', 'repeat', '2026-10-29T14:22:23.000Z');
  const second = userRow('steer_second', 'repeat', '2026-10-29T14:22:35.000Z');
  act(() => {
    result.current.appendRealtime('vnc-session', first);
    result.current.appendRealtime('vnc-session', second);
  });

  history = [userRow('codex_first', 'repeat', '2026-10-29T14:30:00.000Z')];
  await act(async () => { await result.current.refreshLatestFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['steer_second', 'codex_first']);

  history = [...history, userRow('codex_second', 'repeat', '2026-10-29T14:30:00.010Z')];
  await act(async () => { await result.current.refreshLatestFromServer('vnc-session'); });
  assert.deepEqual(result.current.getMessages('vnc-session').map((row) => row.id), ['codex_first', 'codex_second']);
});
