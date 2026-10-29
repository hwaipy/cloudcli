import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * #1587: follow-ups submitted while a turn runs used to replace each other in
 * the session's single queued slot, so only the last one reached the
 * provider and nothing said the others were gone. Every accepted follow-up
 * must now be kept, in order, and the card must show all of them.
 *
 * The server is faked at the HTTP boundary with the drafts contract the real
 * server implements, so these tests see what would be stored in
 * `session_drafts.queued_message` (what the dispatcher sends), not only what
 * the card renders.
 */

type StoredQueued = { id: string; content: string; options?: Record<string, unknown>; attachments: unknown[] };
type StoredDraft = { text: string; queuedMessage: StoredQueued[] };

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION_1: ProjectSession = { id: 'session-1' };
const SESSION_2: ProjectSession = { id: 'session-2' };

let server: Map<string, StoredDraft>;
let refuseQueueing = false;
// Held open by a test to keep an upload in flight (e.g. across a session switch).
let uploadGate: Promise<void> | null = null;
// Held open by a test to keep an append's response in flight. The server has
// already applied the append by then, as a real one would before answering.
let appendGate: Promise<void> | null = null;
let reorderGate: Promise<void> | null = null;
// Held open by a test to keep a clear from reaching the store, as a request
// that took a slower connection would.
let clearGate: Promise<void> | null = null;
let appendRequestCount = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const dropIfEmpty = (scope: string) => {
  const draft = server.get(scope);
  if (draft && !draft.text && draft.queuedMessage.length === 0) {
    server.delete(scope);
  }
};

// The drafts endpoints, as the server implements them.
const fakeServer = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(url);
  const method = init?.method ?? 'GET';
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const scope = String(body.scope ?? '');

  if (path.includes('/api/assets/files')) {
    await uploadGate;
    const form = init?.body instanceof FormData ? init.body : new FormData();
    const files = form.getAll('files') as File[];
    return json({ attachments: files.map((file) => ({ name: file.name, path: `/uploads/${file.name}` })) });
  }

  if (path.endsWith('/api/user/drafts/queued-message')) {
    if (method === 'POST') {
      appendRequestCount += 1;
      if (refuseQueueing) {
        await appendGate;
        return json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
      }
      const message = body.queuedMessage as StoredQueued;
      const current = server.get(scope) ?? { text: '', queuedMessage: [] };
      const queuedMessage: StoredQueued = { ...message, id: `queued-${appendRequestCount}` };
      const queuedMessages = [...current.queuedMessage, queuedMessage];
      server.set(scope, { ...current, queuedMessage: queuedMessages });
      await appendGate;
      return json({ success: true, queuedMessage, queuedMessages, appended: current.queuedMessage.length > 0 });
    }
    if (method === 'DELETE') {
      await clearGate;
      const current = server.get(scope);
      if (current) {
        server.set(scope, { ...current, queuedMessage: current.queuedMessage.filter((item) => item.id !== body.messageId) });
        dropIfEmpty(scope);
      }
      return json({ success: true });
    }
  }

  if (path.endsWith('/api/user/drafts/queued-message/order') && method === 'PATCH') {
    await reorderGate;
    const current = server.get(scope);
    const expectedIds = body.expectedIds as string[];
    const orderedIds = body.orderedIds as string[];
    if (!current || JSON.stringify(current.queuedMessage.map((message) => message.id)) !== JSON.stringify(expectedIds)) {
      return json({ error: { code: 'QUEUE_CHANGED', message: 'The queue changed' } }, 409);
    }
    const byId = new Map(current.queuedMessage.map((message) => [message.id, message]));
    const queuedMessages = orderedIds.map((id) => byId.get(id)!);
    server.set(scope, { ...current, queuedMessage: queuedMessages });
    return json({ success: true, queuedMessages });
  }

  if (path.endsWith('/api/user/drafts')) {
    if (method === 'GET') {
      return json({ success: true, drafts: [...server].map(([draftScope, draft]) => ({ scope: draftScope, ...draft })) });
    }
    if (method === 'PUT') {
      const text = typeof body.text === 'string' ? body.text : '';
      const current = server.get(scope) ?? { text: '', queuedMessage: [] };
      server.set(scope, body.queuedMessage === undefined
        ? { ...current, text }
        : { text, queuedMessage: (body.queuedMessage as StoredQueued[]) ?? [] });
      dropIfEmpty(scope);
      return json({ success: true });
    }
    if (method === 'DELETE') {
      server.delete(scope);
      return json({ success: true });
    }
  }

  return json([]);
};

// What the server's dispatcher does when the session goes idle: take the
// queued message off the queue to send it.
const dispatcherClaims = (scope: string): StoredQueued | null => {
  const draft = server.get(scope);
  const claimed = draft?.queuedMessage[0] ?? null;
  if (draft) {
    server.set(scope, { ...draft, queuedMessage: draft.queuedMessage.slice(1) });
    dropIfEmpty(scope);
  }
  return claimed;
};

type Props = {
  session: ProjectSession;
  isLoading: boolean;
  model: string;
  processingSessions?: SessionActivityMap;
};

const render = (initialProps: Partial<Props> = {}) => {
  const errors: ChatMessage[] = [];
  const view = renderHook(
    ({ session, isLoading, model, processingSessions }: Props) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id ?? null,
      provider: 'claude',
      permissionMode: 'default',
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: model,
      currentProviderEffort: 'medium',
      isLoading,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: (message) => {
        if (message.type === 'error') errors.push(message);
      },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { session: SESSION_1, isLoading: true, model: 'model-1', ...initialProps } },
  );
  return { view, errors };
};

type View = ReturnType<typeof render>['view'];

const submit = async (view: View, text: string, files: File[] = []) => {
  await act(async () => {
    view.result.current.setInput(text);
    view.result.current.setAttachedFiles(files);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

const queuedOnServer = (scope = 'session-1') => server.get(scope)?.queuedMessage ?? [];

const hold = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
};

// Presses Enter without waiting for the submit to finish.
const startSubmit = (view: View) => {
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  return pending;
};

beforeEach(() => {
  server = new Map();
  refuseQueueing = false;
  uploadGate = null;
  appendGate = null;
  reorderGate = null;
  clearGate = null;
  appendRequestCount = 0;
  resetChatDrafts();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(fakeServer));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetChatDrafts();
  localStorage.clear();
});

test('follow-ups stay as separate turns in order with their own files', async () => {
  const { view } = render();
  await submit(view, 'A', [new File(['a'], 'a.txt')]);
  await submit(view, 'B');
  assert.deepEqual(queuedOnServer().map((item) => item.content), ['A', 'B']);
  assert.equal(queuedOnServer()[0]?.attachments.length, 1);
  assert.equal(queuedOnServer()[1]?.attachments.length, 0);
  assert.deepEqual(view.result.current.queuedDrafts.map((item) => item.content), ['A', 'B']);
});

test('reordering queued turns changes the next dispatched message and survives a refresh', async () => {
  const { view } = render();
  await submit(view, 'A');
  await submit(view, 'B');
  await submit(view, 'C');
  await act(async () => { await view.result.current.reorderQueuedDraft('queued-3', 'queued-1'); });
  assert.deepEqual(queuedOnServer().map((message) => message.content), ['C', 'A', 'B']);
  assert.deepEqual(view.result.current.queuedDrafts.map((message) => message.content), ['C', 'A', 'B']);
  assert.equal(dispatcherClaims('session-1')?.content, 'C');
});

test('a claimed head during reorder restores the server queue instead of resurrecting it', async () => {
  const { view } = render();
  await submit(view, 'A');
  await submit(view, 'B');
  const gate = hold();
  reorderGate = gate.gate;
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.reorderQueuedDraft('queued-2', 'queued-1'); });
  assert.deepEqual(view.result.current.queuedDrafts.map((message) => message.content), ['B', 'A']);
  assert.equal(dispatcherClaims('session-1')?.content, 'A');
  gate.release();
  await act(async () => { await pending; });
  await waitFor(() => assert.deepEqual(view.result.current.queuedDrafts.map((message) => message.content), ['B']));
  assert.deepEqual(queuedOnServer().map((message) => message.content), ['B']);
});

test('each card can be deleted without removing its neighbors', async () => {
  const { view } = render();
  await submit(view, 'A');
  await submit(view, 'B');
  await submit(view, 'C');
  const id = view.result.current.queuedDrafts[1]?.id;
  assert.ok(id);
  await act(async () => { view.result.current.deleteQueuedDraft(id); });
  await waitFor(() => assert.deepEqual(queuedOnServer().map((item) => item.content), ['A', 'C']));
  assert.deepEqual(view.result.current.queuedDrafts.map((item) => item.content), ['A', 'C']);
});

test('editing one queued turn restores its text and file', async () => {
  const { view } = render();
  await submit(view, 'A', [new File(['a'], 'a.txt')]);
  await submit(view, 'B');
  const id = view.result.current.queuedDrafts[0]?.id;
  assert.ok(id);
  await act(async () => { view.result.current.editQueuedDraft(id); });
  await waitFor(() => assert.deepEqual(queuedOnServer().map((item) => item.content), ['B']));
  assert.equal(view.result.current.input, 'A');
  assert.deepEqual(view.result.current.attachedFiles.map((file) => file.name), ['a.txt']);
});

test('dispatcher claim removes only the head', async () => {
  const { view } = render();
  await submit(view, 'A');
  await submit(view, 'B');
  assert.equal(dispatcherClaims('session-1')?.content, 'A');
  assert.deepEqual(queuedOnServer().map((item) => item.content), ['B']);
});

test('a rejected queued turn goes back into the composer', async () => {
  const { view, errors } = render();
  refuseQueueing = true;
  await submit(view, 'A');
  assert.equal(view.result.current.input, 'A');
  assert.equal(view.result.current.queuedDrafts.length, 0);
  assert.equal(errors.length, 1);
});

test('session switch restores its independent queue', async () => {
  const { view } = render();
  await submit(view, 'A');
  view.rerender({ session: SESSION_2, isLoading: true, model: 'model-1' });
  await waitFor(() => assert.equal(view.result.current.queuedDrafts.length, 0));
  view.rerender({ session: SESSION_1, isLoading: true, model: 'model-1' });
  await waitFor(() => assert.deepEqual(view.result.current.queuedDrafts.map((item) => item.content), ['A']));
});

test('editing the first card while a second append is pending keeps only the second queued', async () => {
  const { view } = render();
  await submit(view, 'A');
  const gate = hold();
  appendGate = gate.gate;
  await act(async () => { view.result.current.setInput('B'); });
  const pending = startSubmit(view);
  await waitFor(() => assert.deepEqual(queuedOnServer().map((item) => item.content), ['A', 'B']));
  const id = view.result.current.queuedDrafts[0]?.id;
  assert.ok(id);
  await act(async () => { view.result.current.editQueuedDraft(id); });
  await act(async () => { gate.release(); await pending; });
  await waitFor(() => assert.deepEqual(queuedOnServer().map((item) => item.content), ['B']));
  assert.deepEqual(view.result.current.queuedDrafts.map((item) => item.content), ['B']);
  assert.equal(view.result.current.input, 'A');
});
