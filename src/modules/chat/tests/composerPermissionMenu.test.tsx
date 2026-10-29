import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { PermissionMode } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import frChat from '@/modules/i18n/locales/fr/chat.json';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';

const MODES: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];
const MODE_NAMES = ['Default Mode', 'Auto Mode', 'Accept Edits', 'Bypass Permissions', 'Plan Mode'];

const renderMenu = (permissionMode: PermissionMode, onSelectPermissionMode = vi.fn()) =>
  render(
    <ComposerPermissionMenu
      permissionMode={permissionMode}
      permissionModes={MODES}
      onSelectPermissionMode={onSelectPermissionMode}
      providerLabel="Claude"
    />,
  );

test('the mode trigger stays icon-only and announces the active mode', () => {
  for (const [index, mode] of MODES.entries()) {
    const { getByRole, unmount } = renderMenu(mode);
    const trigger = getByRole('button', { name: new RegExp(`^${MODE_NAMES[index]}:`) });
    assert.equal(trigger.textContent, '');
    assert.ok(trigger.querySelector('svg'));
    assert.equal(trigger.classList.contains('w-8'), true);
    unmount();
  }
});

test('the menu still selects a mode', () => {
  const onSelect = vi.fn();
  const { getByRole } = renderMenu('default', onSelect);
  fireEvent.click(getByRole('button', { name: /^Default Mode:/ }));
  fireEvent.click(getByRole('menuitemradio', { name: /Plan Mode/ }));
  assert.deepEqual(onSelect.mock.calls, [['plan']]);
});

test('the icon trigger and menu retain localized accessible names', async () => {
  await act(async () => { await i18n.changeLanguage('fr'); });
  try {
    const { getByRole, getAllByRole } = renderMenu('plan');
    const trigger = getByRole('button');
    const heading = frChat.composer.permissionHeading.replace('{{provider}}', 'Claude');
    assert.equal(trigger.textContent, '');
    assert.equal(
      trigger.getAttribute('aria-label'),
      frChat.composer.permissionTriggerLabel.replace('{{mode}}', frChat.codex.modes.plan).replace('{{heading}}', heading),
    );
    fireEvent.click(trigger);
    assert.equal(getAllByRole('menuitemradio').length, MODES.length);
  } finally {
    await act(async () => { await i18n.changeLanguage('en'); });
  }
});
