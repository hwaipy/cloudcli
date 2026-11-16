import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';
import { useEffect } from 'react';

import '@/modules/i18n';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage, Project, ProjectSession, ServerEvent } from '@/shared/types';

const history = vi.hoisted(() => ({ rows: [] as NormalizedMessage[] }));
vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionTokenUsage: async () => ({ ok: false }),
  sessionMessages: async () => ({ ok: true, json: async () => ({ data: { messages: history.rows, total: history.rows.length, hasMore: false, offset: 0, limit: 100 } }) }),
} } }));

for (const broadcastFirst of [true, false]) test(`phone user bubbles remain single across ACK, broadcast, replay and persisted history (${broadcastFirst ? 'broadcast first' : 'ACK first'})`, async () => {
  history.rows = [];
  const text = 'phone-send-rendering-probe';
  const project: Project = { projectId: 'project', displayName: 'Project', fullPath: '/repo' };
  const session: ProjectSession = { id: 'session' };
  const stableId = 'local_send-mobile';
  const now = new Date().toISOString();
  let listener: (event: ServerEvent) => void = () => {};
  let fallback: () => void = () => {};
  let refresh: () => Promise<unknown> = async () => {};
  const subscribe = (next: typeof listener) => { listener = next; return () => {}; };
  const noop = () => {};
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: '' };
  const processingSessions = new Map();
  const noPermissions: [] = [];
  const diff = () => [];
  function Transcript() {
    const store = useSessionStore();
    const chat = useChatSessionState({ isActive: true, selectedProject: project, selectedSession: session,
      ws: null, sendMessage: noop, resetStreamingState: noop, statusCheckSentAtRef, lastSeqRef,
      sessionStore: store, processingSessions });
    useChatRealtimeHandlers({ isActive: true, subscribe, provider: 'codex', selectedSession: session,
      currentSessionId: session.id, setTokenBudget: noop, pendingPermissionRequests: noPermissions,
      setPendingPermissionRequests: noop, streamTimerRef, accumulatedStreamRef, lastSeqRef, statusCheckSentAtRef,
      requestLatestMessages: async () => { await store.refreshLatestFromServer(session.id); }, sessionStore: store });
    useEffect(() => {
      fallback = () => chat.addMessage({ type: 'user', content: text, timestamp: now, sessionId: session.id, realtimeMessageId: stableId });
      refresh = () => store.refreshLatestFromServer(session.id);
    }, [chat, store]);
    return <UiPreferencesProvider><section aria-label="transcript">{chat.chatMessages.map((message: ChatMessage, index: number) =>
      <MessageComponent key={index} message={message} prevMessage={null} createDiff={diff} provider="codex" />
    )}</section></UiPreferencesProvider>;
  }
  render(<Transcript />);
  await act(async () => {});
  const accepted: NormalizedMessage = { id: stableId, sessionId: session.id, provider: 'codex', kind: 'text', role: 'user', content: text, timestamp: now };
  const emit = (row: NormalizedMessage) => listener(row);
  act(() => { if (broadcastFirst) { emit(accepted); fallback(); } else { fallback(); emit(accepted); } });
  assert.equal(screen.getAllByText(text).length, 1);
  const anchored = { ...accepted, transcriptAnchorId: 'native-turn-1' };
  act(() => { emit(anchored); emit(anchored); });
  assert.equal(screen.getAllByText(text).length, 1);
  history.rows = [{ ...anchored, id: 'codex-history-generated-id' }];
  await act(async () => { await refresh(); });
  await waitFor(() => assert.equal(screen.getAllByText(text).length, 1));
  act(() => emit(anchored));
  assert.equal(screen.getAllByText(text).length, 1, 'a replay after history reconciliation must not recreate the bubble');
  act(() => emit({ ...anchored, id: 'local_send-mobile-2', transcriptAnchorId: 'native-turn-2' }));
  assert.equal(screen.getAllByText(text).length, 2, 'a genuine second same-text send remains visible');
});
