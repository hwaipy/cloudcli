import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';

vi.mock('@/shared/ui', () => ({ DarkModeToggle: () => null }));

test('quick settings keeps the voice switch visible while voice is disabled', async () => {
  await i18n.changeLanguage('en');
  const onPreferenceChange = vi.fn();
  render(<QuickSettingsContent
    isDarkMode={false}
    preferences={{ showRawParameters: false, showThinking: true, sendByCtrlEnter: false, voiceEnabled: false }}
    onPreferenceChange={onPreferenceChange}
  />);

  const toggle = screen.getByLabelText('Voice (mic + read aloud)') as HTMLInputElement;
  assert.equal(toggle.checked, false);
  fireEvent.click(toggle);
  assert.deepEqual(onPreferenceChange.mock.calls, [['voiceEnabled', true]]);
});
