import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession, ServerEvent } from '@/shared/types';

const project: Project = { projectId: 'project-1', displayName: 'Project', fullPath: '/tmp/project' };
const session: ProjectSession = { id: 'codex-session-1' };
let queuedMessages: Array<{ id: string; content: string; attachments: unknown[] }> = [];

beforeEach(() => {
  queuedMessages = [];
  resetChatDrafts();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/api/user/drafts/queued-message') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const queuedMessage = { ...body.queuedMessage, id: `queued-${queuedMessages.length + 1}` };
      queuedMessages.push(queuedMessage);
      return new Response(JSON.stringify({ success: true, queuedMessage, queuedMessages }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.endsWith('/api/user/drafts/queued-message') && init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body));
      queuedMessages = queuedMessages.filter((message) => message.id !== body.messageId);
      return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(path.includes('/files') ? [] : { success: true, drafts: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetChatDrafts();
  localStorage.clear();
});

function setup({ isLoading = true, sendByCtrlEnter = false, codexEnterQueues = false, sendResult }: { isLoading?: boolean; sendByCtrlEnter?: boolean; codexEnterQueues?: boolean; sendResult?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const messages: Array<{ type: string; content: string }> = [];
  let listener: ((event: ServerEvent) => void) | null = null;
  const view = renderHook(() => useChatComposerState({
    selectedProject: project,
    selectedSession: session,
    currentSessionId: session.id,
    provider: 'codex',
    permissionMode: 'default',
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'gpt-5.4',
    currentProviderEffort: 'medium',
    isLoading,
    canSteer: true,
    sendByCtrlEnter,
    codexEnterQueues,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as Record<string, unknown>); return sendResult; },
    subscribe: (callback) => { listener = callback; return () => { listener = null; }; },
    scrollToBottom: () => {},
    addMessage: (message) => { messages.push(message as { type: string; content: string }); },
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
  }));
  return { view, sent, messages, emit: (event: ServerEvent) => listener?.(event) };
}

function enter(view: ReturnType<typeof setup>['view'], modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean } = {}) {
  const preventDefault = vi.fn();
  act(() => view.result.current.handleKeyDown({
    key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false,
    nativeEvent: { isComposing: modifiers.isComposing ?? false }, preventDefault,
    ...modifiers,
  } as never));
  return preventDefault;
}

test('steer keeps the draft until the server accepts it', async () => {
  const { view, sent, emit } = setup();
  act(() => view.result.current.setInput('change direction'));
  act(() => view.result.current.handleSteer());
  assert.equal(view.result.current.input, 'change direction');
  assert.equal(sent[0]?.type, 'chat.steer');
  act(() => emit({ kind: 'chat_steer_accepted', sessionId: session.id, clientMessageId: sent[0]?.clientMessageId }));
  await waitFor(() => assert.equal(view.result.current.input, ''));
});

test('a steer with surrounding whitespace clears the unchanged draft after acceptance', async () => {
  const { view, sent, emit } = setup();
  act(() => view.result.current.setInput('  change direction  '));
  act(() => view.result.current.handleSteer());
  assert.equal(sent[0]?.content, 'change direction');
  act(() => emit({ kind: 'chat_steer_accepted', sessionId: session.id, clientMessageId: sent[0]?.clientMessageId }));
  await waitFor(() => assert.equal(view.result.current.input, ''));
});

test('a refused steer becomes a durable follow-up when the turn ended', async () => {
  const { view, sent, emit } = setup();
  act(() => view.result.current.setInput('change direction'));
  act(() => view.result.current.handleSteer());
  act(() => emit({ kind: 'protocol_error', code: 'NO_ACTIVE_CODEX_TURN', sessionId: session.id, clientMessageId: sent[0]?.clientMessageId }));
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['change direction']));
  assert.equal(view.result.current.input, '');
});

test('a steer unavailable before Codex starts also becomes a follow-up', async () => {
  const { view, sent, emit } = setup();
  act(() => view.result.current.setInput('do this next'));
  act(() => view.result.current.handleSteer());
  act(() => emit({ kind: 'protocol_error', code: 'STEER_UNAVAILABLE', sessionId: session.id, clientMessageId: sent[0]?.clientMessageId }));
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['do this next']));
});

test('a disconnected steer queues the message instead of silently leaving it unsent', async () => {
  const { view, messages } = setup({ sendResult: false });
  act(() => view.result.current.setInput('follow up'));
  act(() => view.result.current.handleSteer());
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['follow up']));
  assert.equal(view.result.current.input, '');
  assert.equal(messages.some((message) => message.type === 'error'), false);
});

test('an idle send with a disconnected socket keeps its draft and does not show a sent echo', async () => {
  const { view, messages } = setup({ isLoading: false, sendResult: false });
  act(() => view.result.current.setInput('retry me'));
  await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  assert.equal(view.result.current.input, 'retry me');
  assert.equal(messages.filter((message) => message.type === 'user').length, 0);
  assert.equal(messages.filter((message) => message.type === 'error').length, 1);
});

test('a disconnected queued-row steer leaves that row queued', async () => {
  const { view, messages } = setup({ sendResult: false });
  act(() => view.result.current.setInput('queued text'));
  await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  const id = view.result.current.queuedDrafts[0]?.id;
  act(() => view.result.current.steerQueuedDraft(id!));
  assert.deepEqual(queuedMessages.map((message) => message.content), ['queued text']);
  assert.equal(view.result.current.queuedDrafts.length, 1);
  assert.equal(messages.filter((message) => message.type === 'error').length, 1);
});

test('steering a queued row waits for acknowledgement before removing only that row', async () => {
  const { view, sent, emit } = setup();
  act(() => view.result.current.setInput('queued text'));
  await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  await waitFor(() => assert.equal(view.result.current.queuedDrafts.length, 1));
  const id = view.result.current.queuedDrafts[0].id!;

  act(() => view.result.current.steerQueuedDraft(id));
  assert.equal(sent.at(-1)?.type, 'chat.steer');
  assert.equal(sent.at(-1)?.queuedMessageId, id);
  assert.equal(view.result.current.queuedDrafts.length, 1);
  act(() => emit({ kind: 'protocol_error', code: 'STEER_UNAVAILABLE', sessionId: session.id, clientMessageId: sent.at(-1)?.clientMessageId }));
  assert.equal(view.result.current.queuedDrafts.length, 1);

  act(() => view.result.current.steerQueuedDraft(id));
  act(() => emit({ kind: 'chat_steer_accepted', sessionId: session.id, clientMessageId: sent.at(-1)?.clientMessageId }));
  await waitFor(() => assert.equal(view.result.current.queuedDrafts.length, 0));
  await waitFor(() => assert.equal(queuedMessages.length, 0));
});

test('macOS Enter steers, Command+Enter queues, and Shift+Enter stays a newline', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent, emit } = setup({ sendByCtrlEnter: true });
  act(() => view.result.current.setInput('steer text'));
  assert.equal(enter(view).mock.calls.length, 1);
  assert.equal(sent.at(-1)?.type, 'chat.steer');
  act(() => emit({ kind: 'chat_steer_accepted', sessionId: session.id, clientMessageId: sent.at(-1)?.clientMessageId }));
  await waitFor(() => assert.equal(view.result.current.input, ''));

  act(() => view.result.current.setInput('queued text'));
  assert.ok(enter(view, { metaKey: true }).mock.calls.length >= 1);
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['queued text']));
  assert.equal(sent.filter((message) => message.type === 'chat.steer').length, 1);

  act(() => view.result.current.setInput('new line'));
  assert.equal(enter(view, { shiftKey: true }).mock.calls.length, 0);
  assert.equal(view.result.current.input, 'new line');
});

test('Windows Ctrl+Enter queues while Enter steers; Windows-key+Enter does not queue', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent } = setup();
  act(() => view.result.current.setInput('plain steer'));
  enter(view);
  assert.equal(sent.at(-1)?.type, 'chat.steer');

  act(() => view.result.current.setInput('queued text'));
  enter(view, { ctrlKey: true });
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['queued text']));

  act(() => view.result.current.setInput('not queued'));
  enter(view, { metaKey: true });
  assert.deepEqual(queuedMessages.map((message) => message.content), ['queued text']);
});

test('queue preference makes Mac Enter queue and Command+Enter steer', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent } = setup({ codexEnterQueues: true, sendByCtrlEnter: true });

  act(() => view.result.current.setInput('next turn'));
  enter(view);
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['next turn']));
  assert.equal(view.result.current.input, '');

  act(() => view.result.current.setInput('change direction'));
  enter(view, { metaKey: true });
  assert.equal(sent.at(-1)?.type, 'chat.steer');
  assert.equal(sent.at(-1)?.content, 'change direction');
});

test('queue preference makes Windows Enter queue and Ctrl+Enter steer', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent } = setup({ codexEnterQueues: true });

  act(() => view.result.current.setInput('next turn'));
  enter(view);
  await waitFor(() => assert.deepEqual(queuedMessages.map((message) => message.content), ['next turn']));

  act(() => view.result.current.setInput('change direction'));
  enter(view, { ctrlKey: true });
  assert.equal(sent.at(-1)?.type, 'chat.steer');
  assert.equal(sent.at(-1)?.content, 'change direction');
});

test('idle Enter still sends a normal turn and IME confirmation never submits', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent } = setup({ isLoading: false });
  act(() => view.result.current.setInput('hello'));
  assert.equal(enter(view, { isComposing: true }).mock.calls.length, 0);
  assert.equal(sent.length, 0);
  assert.ok(enter(view).mock.calls.length >= 1);
  await waitFor(() => assert.equal(sent.at(-1)?.type, 'chat.send'));
});

test('queue preference does not change idle Enter behavior', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const { view, sent } = setup({ isLoading: false, codexEnterQueues: true });
  act(() => view.result.current.setInput('hello'));
  enter(view);
  await waitFor(() => assert.equal(sent.at(-1)?.type, 'chat.send'));
});
