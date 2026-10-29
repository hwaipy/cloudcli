import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ComposerModelMenu } from '@/modules/chat/composer/ComposerModelMenu';
import { ComposerEffortMenu } from '@/modules/chat/composer/ComposerEffortMenu';

const models = [
  { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
];
const efforts = [{ value: 'low' }, { value: 'medium' }, { value: 'high' }];

test('model and reasoning effort have independent buttons and menus', () => {
  const selectModel = vi.fn();
  const selectEffort = vi.fn();
  const { getByRole, queryByRole } = render(
    <>
      <ComposerModelMenu model="gpt-6-sol" modelOptions={models} onSelectModel={selectModel} modelsLoading={false} />
      <ComposerEffortMenu effort="low" effortOptions={efforts} onSelectEffort={selectEffort} />
    </>,
  );

  const modelTrigger = getByRole('button', { name: 'Model: GPT-6 Sol' });
  const effortTrigger = getByRole('button', { name: 'Reasoning effort: low' });
  assert.equal(modelTrigger.textContent, 'GPT-6 Sol');
  assert.equal(effortTrigger.textContent, '');
  assert.ok(effortTrigger.querySelector('[data-effort-needle]'));

  fireEvent.click(modelTrigger);
  assert.equal(getByRole('menu').getAttribute('aria-label'), 'Model: GPT-6 Sol');
  fireEvent.click(getByRole('menuitemradio', { name: 'GPT-6 Astra' }));
  assert.deepEqual(selectModel.mock.calls, [['gpt-6-astra']]);
  assert.equal(queryByRole('menu'), null);

  fireEvent.click(effortTrigger);
  assert.equal(getByRole('menu').getAttribute('aria-label'), 'Reasoning effort: low');
  fireEvent.click(getByRole('menuitemradio', { name: 'high' }));
  assert.deepEqual(selectEffort.mock.calls, [['high']]);
});

test('the half-dial needle moves with the selected effort', () => {
  const view = (effort: string) =>
    <ComposerEffortMenu effort={effort} effortOptions={efforts} onSelectEffort={() => {}} />;
  const { container, rerender } = render(view('low'));
  const needle = () => container.querySelector('[data-effort-needle]')?.getAttribute('d');
  const low = needle();
  rerender(view('medium'));
  const medium = needle();
  rerender(view('high'));
  const high = needle();
  assert.notEqual(low, medium);
  assert.notEqual(medium, high);
});
