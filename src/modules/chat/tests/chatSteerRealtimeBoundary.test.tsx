import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

test('Steer acknowledgement and unknown control frames never enter the transcript', () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const messages: NormalizedMessage[] = [];
  const refreshed: string[] = [];
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (callback) => { listener = callback; return () => { listener = null; }; },
    provider: 'codex',
    selectedSession: { id: 'session-1' } as ProjectSession,
    currentSessionId: 'session-1',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async (sessionId) => { refreshed.push(sessionId); },
    sessionStore: {
      appendRealtime: (_sessionId: string, message: NormalizedMessage) => { messages.push(message); },
      getMessages: () => messages,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  const emit = (frame: Record<string, unknown>) => {
    act(() => listener?.({ sessionId: 'session-1', provider: 'codex', timestamp: '2026-10-29T13:00:00.000Z', ...frame }));
  };
  emit({ kind: 'text', id: 'steer-1', role: 'user', content: '从零开始' });
  emit({ kind: 'chat_steer_accepted', clientMessageId: 'client-1' });
  emit({ kind: 'unrecognized_control', id: 'control-1' });
  emit({ kind: 'text', id: 'update-1', role: 'assistant', content: '正在修改', codexPhase: 'commentary' });
  emit({ kind: 'text', id: 'final-1', role: 'assistant', content: '完成', codexPhase: 'final_answer' });
  emit({ kind: 'complete', id: 'complete-1', success: false });

  assert.deepEqual(messages.map((message) => message.id), ['steer-1', 'update-1', 'final-1']);
  assert.deepEqual(refreshed, ['session-1']);
});
