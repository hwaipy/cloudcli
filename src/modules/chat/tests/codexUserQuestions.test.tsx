import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';
import type { PendingPermissionRequest } from '@/shared/types';

afterEach(cleanup);
function show(questions: unknown[]) {
  const decision = vi.fn();
  render(<PermissionRequestsBanner pendingPermissionRequests={[{ requestId: 'codex-question-test', toolName: 'AskUserQuestion',
    sessionId: 'session', input: { questions } } as PendingPermissionRequest]} handlePermissionDecision={decision} handleGrantToolPermission={() => ({ success: true })} />);
  return decision;
}
test('a Codex choice uses the interactive panel and answers with its stable question ID', () => {
  const decision = show([{ id: 'color-id', header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'Recommended' }, { label: 'Red', description: 'Alternative' }] }]);
  expect(screen.getByRole('radiogroup', { name: 'Which color?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
  fireEvent.click(screen.getByRole('button', { name: /Submit|提交|发送/i }));
  expect(decision).toHaveBeenCalledWith('codex-question-test', expect.objectContaining({ allow: true,
    updatedInput: expect.objectContaining({ answers: { 'color-id': 'Blue' } }) }));
});

test('Codex questions without options immediately offer a free-text answer', () => {
  const decision = show([{ id: 'project-name', header: 'Name', question: 'What is the project name?', options: null }]);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'CloudCLI' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(decision).toHaveBeenCalledWith('codex-question-test', expect.objectContaining({ updatedInput: expect.objectContaining({ answers: { 'project-name': 'CloudCLI' } }) }));
});

test('secret questions use a password input, answered history masks the value', () => {
  show([{ id: 'secret', header: 'Secret', question: 'Secret value?', options: [], isSecret: true }]);
  expect(document.querySelector('input[type=password]')).toBeTruthy();
  cleanup();
  const { container } = render(<QuestionAnswerContent questions={[{ id: 'secret', question: 'Secret value?', options: [], isSecret: true }]} answers={{ secret: 'test-sensitive-answer' }} />);
  expect(container.textContent).not.toContain('test-sensitive-answer');
  expect(container.textContent).toContain('••••••••');
});

test('multiple questions with identical text retain distinct Codex IDs', () => {
  const decision = show([
    { id: 'first', header: 'First', question: 'Pick one?', options: [{ label: 'Blue', description: 'First' }, { label: 'Red', description: 'Second' }] },
    { id: 'second', header: 'Second', question: 'Pick one?', options: [{ label: 'Blue', description: 'First' }, { label: 'Red', description: 'Second' }] },
  ]);
  fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
  fireEvent.click(screen.getByRole('button', { name: /Next|下一/i }));
  fireEvent.click(screen.getByRole('button', { name: /Red/ }));
  fireEvent.click(screen.getByRole('button', { name: /Submit|提交|发送/i }));
  expect(decision).toHaveBeenCalledWith('codex-question-test', expect.objectContaining({ updatedInput: expect.objectContaining({ answers: { first: 'Blue', second: 'Red' } }) }));
});
