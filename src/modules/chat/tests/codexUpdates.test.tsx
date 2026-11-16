import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { foldCodexUpdates } from '@/modules/chat/utils/codexUpdates';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

const row = (id: string, codexPhase: NormalizedMessage['codexPhase']): NormalizedMessage => ({
  id,
  sessionId: 'codex-session',
  timestamp: '2026-10-28T12:00:00Z',
  provider: 'codex',
  kind: 'text',
  role: 'assistant',
  content: id,
  codexPhase,
});

test('Codex phases survive normalization and updates collapse only after a final answer', () => {
  const updates = normalizedToChatMessages([row('investigating', 'commentary'), row('testing', 'commentary')]);
  assert.deepEqual(updates.map((message) => message.codexPhase), ['commentary', 'commentary']);
  assert.equal(foldCodexUpdates(updates, 'codex').length, 2);

  const completed = foldCodexUpdates([...updates, ...normalizedToChatMessages([row('done', 'final_answer')])], 'codex');
  assert.equal(completed.length, 2);
  assert.deepEqual(completed[0].codexUpdates?.map((message) => message.content), ['investigating', 'testing']);
  assert.equal(completed[1].content, 'done');
  assert.equal(foldCodexUpdates([...updates, completed[1]], 'claude').length, 3);
});

test('a new user turn does not fold updates into an earlier final answer', () => {
  const messages: ChatMessage[] = [
    { type: 'assistant', content: 'old update', codexPhase: 'commentary', timestamp: 1 },
    { type: 'user', content: 'new question', timestamp: 2 },
    { type: 'assistant', content: 'new update', codexPhase: 'commentary', timestamp: 3 },
    { type: 'assistant', content: 'new answer', codexPhase: 'final_answer', timestamp: 4 },
  ];
  const folded = foldCodexUpdates(messages, 'codex');
  assert.equal(folded[0].content, 'old update');
  assert.deepEqual(folded[2].codexUpdates?.map((message) => message.content), ['new update']);
});

test('Codex work opens as an ordered timeline while the final answer stays outside it', () => {
  const messages = foldCodexUpdates(normalizedToChatMessages([
    row('work in progress', 'commentary'),
    {
      id: 'command', sessionId: 'codex-session', timestamp: '2026-10-28T12:00:01Z',
      provider: 'codex', kind: 'tool_use', role: 'assistant', content: '',
      toolName: 'Bash', toolInput: { command: 'pwd' }, toolId: 'command-1',
    },
    { ...row('tests passed', 'commentary'), timestamp: '2026-10-28T12:00:02Z' },
    row('the answer', 'final_answer'),
  ]), 'codex');

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].codexUpdates?.map((message) => message.isToolUse ? message.toolName : message.content),
    ['work in progress', 'Bash', 'tests passed']);

  render(
    <UiPreferencesProvider>
      <MessageComponent message={messages[0]} prevMessage={null} createDiff={() => []} provider="codex" />
      <MessageComponent message={messages[1]} prevMessage={messages[0]} createDiff={() => []} provider="codex" />
    </UiPreferencesProvider>,
  );

  const toggle = screen.getByRole('button', { name: /Worked for 0s/ });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  const work = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  assert.ok(work);
  assert.equal(work.getAttribute('aria-hidden'), 'true');
  assert.match(work.className, /grid-rows-\[0fr\]/);
  assert.ok(screen.getByText('the answer'));
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(work.getAttribute('aria-hidden'), 'false');
  assert.match(work.className, /grid-rows-\[1fr\]/);
  assert.match(work.className, /transition-\[grid-template-rows,opacity\]/);
  assert.ok(screen.getByText('work in progress'));
  assert.ok(screen.getByText('pwd'));
  assert.ok(screen.getByText('tests passed'));
  assert.equal(work.contains(screen.getByText('the answer')), false);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.match(work.className, /grid-rows-\[0fr\]/);
});

test('Codex work duration uses the user prompt rather than the first progress note', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'question', timestamp: '2026-10-28T12:00:00Z' },
    { type: 'assistant', content: 'working', codexPhase: 'commentary', timestamp: '2026-10-28T12:00:02Z' },
    { type: 'assistant', content: 'answer', codexPhase: 'final_answer', timestamp: '2026-10-28T12:03:26Z' },
  ];
  const folded = foldCodexUpdates(messages, 'codex');
  assert.equal(folded[1].codexWorkDurationMs, 206_000);
});

test('completed Codex updates group mixed calls and reveal only the selected call details', () => {
  const calls: ChatMessage[] = [
    { type: 'tool', content: '', isToolUse: true, toolName: 'Bash', toolId: 'nested-bash', toolInput: { command: 'echo one' }, toolResult: { content: 'unique-command-output' }, timestamp: 1 },
    { type: 'tool', content: '', isToolUse: true, toolName: 'Write', toolId: 'nested-write', toolInput: { file_path: '/sample.txt', content: 'unique-file-content' }, timestamp: 2 },
  ];
  render(<UiPreferencesProvider><MessageComponent message={{ type: 'assistant', content: '', timestamp: 3, codexUpdates: calls }} prevMessage={null} createDiff={() => []} provider="codex" /></UiPreferencesProvider>);
  const workToggle = screen.getByRole('button', { name: /Worked for/ });
  fireEvent.click(workToggle);
  const group = screen.getByRole('button', { name: /工具调用/ });
  assert.equal(group.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByText('unique-command-output'), null);
  fireEvent.click(group);
  const command = screen.getByRole('button', { name: /echo one/, expanded: false });
  assert.equal(command.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByText('unique-command-output'), null);
  assert.equal(screen.queryByText('unique-file-content'), null);
  fireEvent.click(command);
  assert.ok(screen.getByText('unique-command-output'));
  assert.equal(screen.queryByText('unique-file-content'), null);
});
