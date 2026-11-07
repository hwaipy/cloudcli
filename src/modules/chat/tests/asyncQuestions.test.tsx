import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { AsyncQuestions } from '@/modules/chat/transcript/AsyncQuestions';
import { QuestionAnswerContext } from '@/modules/chat/context/QuestionAnswerContext';
const send = vi.fn(async (_text: string) => {});
afterEach(() => { cleanup(); send.mockClear(); });
function card(questions: unknown) { return <QuestionAnswerContext.Provider value={send}><AsyncQuestions questions={questions} /></QuestionAnswerContext.Provider>; }
test('choice sends immediately and prevents double submission before the transcript confirms it', async () => {
  const view = render(card([{ title: 'Can you answer?', options: ['Yes', 'No'] }]));
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  expect(send).toHaveBeenCalledWith('回答「Can you answer?」：Yes');
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  expect(send).toHaveBeenCalledTimes(1);
  view.rerender(card([{ title: 'Can you answer?', options: ['Yes', 'No'], answered: true, answer: 'Yes' }]));
  expect(screen.getByRole('button', { name: '✓ Yes' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('status').textContent).toBe('已回答：Yes');
});
test('custom answer submits within its question form', () => {
  render(card([{ title: 'Pick?', options: ['Yes'] }]));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Custom answer' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(send).toHaveBeenCalledWith('回答「Pick?」：Custom answer');
});
test('transport failure keeps custom reply and allows retry', async () => {
  send.mockRejectedValueOnce(new Error('offline'));
  render(card([{ title: 'Pick?', options: [] }]));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('失败'));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep me');
  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(false);
});
test('answered questions retain the answer and disable every option', () => {
  render(card([{ title: 'Done?', options: ['Yes', 'No'], answered: true, answer: 'Other' }]));
  expect(screen.getByRole('status').textContent).toContain('已回答：Other');
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
});
