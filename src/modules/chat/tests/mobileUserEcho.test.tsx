import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionTokenUsage: async () => ({ ok: false }),
  sessionMessages: async () => ({ ok: true, json: async () => ({ data: { messages: [], total: 0, hasMore: false } }) }),
} } }));

for (const broadcastFirst of [true, false]) test(`legacy mobile send ACK and gateway broadcast merge without history refresh (${broadcastFirst ? 'broadcast first' : 'ACK first'})`, async () => {
  const project: Project = { projectId: 'project', displayName: 'Project', fullPath: '/repo' };
  const session: ProjectSession = { id: 'session' };
  const sendMessage = vi.fn(); const resetStreamingState = vi.fn();
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const processingSessions = new Map();
  const view = renderHook(() => {
    const store = useSessionStore();
    const chat = useChatSessionState({ isActive: true, selectedProject: project, selectedSession: session,
      ws: null, sendMessage, resetStreamingState,
      statusCheckSentAtRef, lastSeqRef,
      sessionStore: store, processingSessions });
    return { store, chat };
  });
  await act(async () => {});
  const accepted: NormalizedMessage = { id: 'local_send-request', sessionId: 'session', kind: 'text', role: 'user',
    provider: 'codex', content: 'one mobile message', timestamp: new Date().toISOString(), transcriptAnchorId: 'native-turn' };
  const fallback = () => view.result.current.chat.addMessage({ type: 'user', content: accepted.content,
    timestamp: new Date(), sessionId: 'session', realtimeMessageId: accepted.id });
  const broadcast = () => view.result.current.store.appendRealtime('session', accepted);
  act(() => { if (broadcastFirst) { broadcast(); fallback(); } else { fallback(); broadcast(); } });
  const messages = view.result.current.store.getMessages('session');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, accepted.id);
  assert.equal(messages[0].transcriptAnchorId, 'native-turn');
  act(() => { fallback(); broadcast(); });
  assert.equal(view.result.current.store.getMessages('session').length, 1, 'replay is idempotent');
  act(() => view.result.current.store.appendRealtime('session', { ...accepted, id: 'local_second-request', transcriptAnchorId: 'second-turn' }));
  assert.equal(view.result.current.store.getMessages('session').length, 2, 'two genuine identical sends remain distinct');
});
