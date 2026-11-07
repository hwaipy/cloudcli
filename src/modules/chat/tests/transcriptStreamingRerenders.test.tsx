import assert from 'node:assert/strict';

import { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

/**
 * A provider run flushes roughly ten times a second, and every flush re-renders
 * the transcript with a fresh array. Only the row that grew should cost a
 * render; the collapsed tool-call groups above it must bail out of their memo.
 *
 * Counted through the render-context hook every transcript row calls at the top
 * of its body, which is the cheapest place to observe "this component's body
 * ran" without wrapping the components under test.
 */
let rowRenders = 0;
vi.mock('@/modules/chat/context/TranscriptRenderContext', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useIsExportingTranscript: () => {
      rowRenders += 1;
      return false;
    },
  };
});

const TOOL_RUN_LENGTH = 3;
const TOOL_GROUP_COUNT = 4;

const toolRow = (index: number, call: number): ChatMessage => ({
  type: 'tool',
  content: '',
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, call)).toISOString(),
  isToolUse: true,
  toolName: 'Read',
  toolInput: JSON.stringify({ file_path: `/src/file-${index}-${call}.ts` }),
});

const assistantRow = (index: number): ChatMessage => ({
  type: 'assistant',
  content: `Reviewed batch ${index}.`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 59)).toISOString(),
});

/** Runs of same-tool calls, each long enough to collapse into one group row. */
function buildHistory(): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let index = 0; index < TOOL_GROUP_COUNT; index += 1) {
    for (let call = 0; call < TOOL_RUN_LENGTH; call += 1) {
      rows.push(toolRow(index, call));
    }
    rows.push(assistantRow(index));
  }
  return rows;
}

const noop = () => undefined;
const stable = {
  scrollContainerRef: createRef<HTMLDivElement>(),
  textareaRef: createRef<HTMLTextAreaElement>(),
  selectedSession: { id: 'session-1' },
  selectedProject: { projectId: 'project-1', name: 'repo', path: '/repo' },
  providerModels: {},
  providerModelCatalog: {},
  providerModelActions: {},
  createDiff: () => [],
  onGrantToolPermission: () => ({ success: true }),
};

function paneProps(chatMessages: ChatMessage[]) {
  return {
    ...stable,
    onWheel: noop,
    onTouchMove: noop,
    isLoadingSessionMessages: false,
    sessionHistoryStatus: 'idle',
    onRetrySessionHistory: noop,
    chatMessages,
    currentSessionId: 'session-1',
    provider: 'claude',
    setProvider: noop,
    setProviderModel: noop,
    providerModelsLoading: false,
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    onShowAllTasks: null,
    setInput: noop,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: chatMessages.length,
    sessionMessagesCount: chatMessages.length,
    visibleMessageCount: 1000,
    visibleMessages: chatMessages,
    queuedDrafts: [],
    canSteerQueuedDrafts: false,
    onEditQueuedDraft: noop,
    onDeleteQueuedDraft: noop,
    onReorderQueuedDraft: noop,
    onSteerQueuedDraft: noop,
    loadEarlierMessages: noop,
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    showRawParameters: false,
    showThinking: true,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const pane = (chatMessages: ChatMessage[]) => (
  <UiPreferencesProvider>
    <ChatMessagesPane {...(paneProps(chatMessages) as any)} />
  </UiPreferencesProvider>
);
/* eslint-enable @typescript-eslint/no-explicit-any */

test('a stream tick re-renders the growing row, not the collapsed tool groups above it', { timeout: 30_000 }, () => {
  const history = buildHistory();
  let streaming: ChatMessage = {
    type: 'assistant',
    content: 'Here',
    timestamp: '2026-01-01T00:10:00.000Z',
  };

  const view = render(pane([...history, streaming]));
  assert.equal(
    view.container.querySelectorAll('.chat-message.tool > button[aria-expanded]').length,
    TOOL_GROUP_COUNT,
    'the fixture must actually collapse its tool runs into groups',
  );

  const perFlush: number[] = [];
  for (let flush = 1; flush <= 3; flush += 1) {
    streaming = { ...streaming, content: `${streaming.content} token${flush}` };
    const before = rowRenders;
    view.rerender(pane([...history, streaming]));
    perFlush.push(rowRenders - before);
  }

  assert.deepEqual(
    perFlush,
    [1, 1, 1],
    `only the streaming row may re-render per flush; got ${JSON.stringify(perFlush)}`,
  );
});

test('a failed transcript load is visible and offers a retry action', () => {
  const retry = vi.fn();
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane
        {...(paneProps([]) as any)}
        sessionHistoryStatus="error"
        sessionHistoryErrorCode="CODEX_HISTORY_SOURCE_UNAVAILABLE"
        onRetrySessionHistory={retry}
      />
    </UiPreferencesProvider>,
  );

  assert.ok(view.getByRole('alert').textContent?.trim());
  fireEvent.click(view.getByRole('alert').querySelector('button') as HTMLButtonElement);
  assert.equal(retry.mock.calls.length, 1);
});

test('the active work indicator is the last item in the scrolling transcript', () => {
  const chatMessages = [assistantRow(0)];
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane
        {...(paneProps(chatMessages) as any)}
        activity={{ statusText: 'Computing', canInterrupt: true, startedAt: Date.now() }}
      />
    </UiPreferencesProvider>,
  );

  const transcript = view.container.querySelector('.chat-messages-pane');
  const workRow = transcript?.querySelector('[role="status"]');
  assert.ok(workRow);
  assert.equal(workRow.parentElement?.lastElementChild, workRow);
  assert.match(workRow.textContent ?? '', /Computing/);
});

test('queued turns follow the active response inside the scrolling transcript and retain their actions', () => {
  const chatMessages = [assistantRow(0)];
  const onEditQueuedDraft = vi.fn();
  const onDeleteQueuedDraft = vi.fn();
  const onReorderQueuedDraft = vi.fn();
  const onSteerQueuedDraft = vi.fn();
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane
        {...(paneProps(chatMessages) as any)}
        activity={{ statusText: 'Computing', canInterrupt: true, startedAt: Date.now() }}
        queuedDrafts={[
          { id: 'first', content: 'First follow-up', attachments: [] },
          { id: 'second', content: 'Second follow-up', attachments: [] },
        ]}
        canSteerQueuedDrafts
        onEditQueuedDraft={onEditQueuedDraft}
        onDeleteQueuedDraft={onDeleteQueuedDraft}
        onReorderQueuedDraft={onReorderQueuedDraft}
        onSteerQueuedDraft={onSteerQueuedDraft}
      />
    </UiPreferencesProvider>,
  );

  const transcript = view.container.querySelector('.chat-messages-pane');
  const workRow = transcript?.querySelector('[role="status"]');
  const queue = transcript?.querySelector('[aria-label="Queued messages"]');
  assert.ok(workRow);
  assert.ok(queue);
  assert.equal(workRow.nextElementSibling, queue);
  assert.match(queue.textContent ?? '', /First follow-up.*Second follow-up/);

  fireEvent.click(view.getAllByRole('button', { name: 'Steer' })[0]);
  fireEvent.click(view.getAllByRole('button', { name: 'Edit queued message' })[0]);
  fireEvent.click(view.getAllByRole('button', { name: 'Delete queued message' })[0]);
  fireEvent.click(view.getAllByRole('button', { name: 'Move queued message down' })[0]);
  assert.deepEqual(onSteerQueuedDraft.mock.calls[0], ['first']);
  assert.deepEqual(onEditQueuedDraft.mock.calls[0], ['first']);
  assert.deepEqual(onDeleteQueuedDraft.mock.calls[0], ['first']);
  assert.deepEqual(onReorderQueuedDraft.mock.calls[0], ['first', 'second']);
});

test('queued turns stay below Codex updates and thinking throughout an asynchronous turn', async () => {
  const userMessage: ChatMessage = {
    type: 'user',
    content: 'Review the deployment plan',
    timestamp: '2026-01-01T00:10:00.000Z',
  };
  const update: ChatMessage = {
    type: 'assistant',
    content: 'I am checking the deployment steps.',
    timestamp: '2026-01-01T00:10:01.000Z',
    codexPhase: 'commentary',
  };
  const thinking: ChatMessage = {
    type: 'assistant',
    content: 'Comparing the service topology.',
    timestamp: '2026-01-01T00:10:02.000Z',
    codexPhase: 'commentary',
    isThinking: true,
  };
  const queuedDrafts = [{ id: 'queued-1', content: 'Also verify the health check', attachments: [] }];
  let transcript: ChatMessage[] = [userMessage];
  let activity: { statusText: string; canInterrupt: boolean; startedAt: number } | null = null;
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane
        {...(paneProps(transcript) as any)}
        provider="codex"
        activity={activity}
        queuedDrafts={queuedDrafts}
      />
    </UiPreferencesProvider>,
  );

  const assertQueueFollowsCodexTail = (stage: string) => {
    const rows = Array.from(view.container.querySelectorAll('.chat-message'));
    const queue = view.container.querySelector('[aria-label="Queued messages"]');
    assert.ok(queue, `${stage}: queue must remain visible`);
    const status = view.container.querySelector('[role="status"]');
    if (status) {
      assert.equal(status.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING,
        `${stage}: activity status must precede the queue`);
    }
    for (const row of rows) {
      assert.equal(row.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING,
        `${stage}: every transcript update/thinking row must precede the queue`);
    }
  };

  // Simulate the real event order: queue persistence can finish before the
  // first status/update frame reaches the browser.
  assertQueueFollowsCodexTail('queue persisted');
  await act(async () => {
    activity = { statusText: 'Thinking', canInterrupt: true, startedAt: Date.now() };
    view.rerender(
      <UiPreferencesProvider>
        <ChatMessagesPane {...(paneProps(transcript) as any)} provider="codex" activity={activity} queuedDrafts={queuedDrafts} />
      </UiPreferencesProvider>,
    );
  });
  assertQueueFollowsCodexTail('thinking status arrived');

  await act(async () => {
    transcript = [userMessage, update];
    activity = { ...activity!, statusText: 'Reading files' };
    view.rerender(
      <UiPreferencesProvider>
        <ChatMessagesPane {...(paneProps(transcript) as any)} provider="codex" activity={activity} queuedDrafts={queuedDrafts} />
      </UiPreferencesProvider>,
    );
  });
  assertQueueFollowsCodexTail('commentary update arrived');

  await act(async () => {
    transcript = [userMessage, update, thinking];
    view.rerender(
      <UiPreferencesProvider>
        <ChatMessagesPane {...(paneProps(transcript) as any)} provider="codex" activity={activity} queuedDrafts={queuedDrafts} />
      </UiPreferencesProvider>,
    );
  });
  assertQueueFollowsCodexTail('thinking message arrived');

  await act(async () => {
    transcript = [userMessage, update, thinking, {
      type: 'assistant', content: 'The plan is ready.', timestamp: '2026-01-01T00:10:03.000Z', codexPhase: 'final_answer',
    }];
    activity = null;
    view.rerender(
      <UiPreferencesProvider>
        <ChatMessagesPane {...(paneProps(transcript) as any)} provider="codex" activity={activity} queuedDrafts={queuedDrafts} />
      </UiPreferencesProvider>,
    );
  });
  assertQueueFollowsCodexTail('final answer arrived');
});
