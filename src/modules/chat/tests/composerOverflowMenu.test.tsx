import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ComposerOverflowMenu } from '@/modules/chat/composer/ComposerOverflowMenu';

test('the overflow menu lists collapsed controls in priority order and keeps their actions', () => {
  const selectModel = vi.fn();
  const selectEffort = vi.fn();
  const selectPermission = vi.fn();
  const showTokens = vi.fn();
  render(<ComposerOverflowMenu
    collapseCount={5}
    usage={{ used: 40_000, total: 100_000, sessionTotalTokens: 1_000_000 }}
    onShowTokenUsage={showTokens}
    model="gpt-6-sol"
    modelOptions={[{ value: 'gpt-6-sol', label: 'GPT-6 Sol' }, { value: 'gpt-6-astra', label: 'GPT-6 Astra' }]}
    modelsLoading={false}
    onSelectModel={selectModel}
    effort="medium"
    effortOptions={[{ value: 'low' }, { value: 'medium' }, { value: 'high' }]}
    onSelectEffort={selectEffort}
    permissionMode="default"
    permissionModes={['default', 'plan']}
    onSelectPermissionMode={selectPermission}
  />);

  const open = () => fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  open();
  const menu = screen.getByRole('menu');
  const labels = Array.from(menu.children).slice(1).map((element) => element.textContent?.trim());
  assert.ok(labels[0]?.includes('Session total'));
  assert.ok(labels[1]?.includes('Context'));
  assert.ok(labels[2]?.includes('Reasoning'));
  assert.ok(labels[3]?.includes('Model'));
  assert.ok(labels[4]?.includes('Permissions'));

  fireEvent.click(screen.getByRole('button', { name: /Session total: 1,000,000/ }));
  assert.equal(showTokens.mock.calls.length, 1);
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /Model:/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-6 Astra' }));
  assert.deepEqual(selectModel.mock.calls, [['gpt-6-astra']]);

  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /Reasoning:/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
  assert.deepEqual(selectEffort.mock.calls, [['high']]);

  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /Permissions:/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Plan/ }));
  assert.deepEqual(selectPermission.mock.calls, [['plan']]);
});
