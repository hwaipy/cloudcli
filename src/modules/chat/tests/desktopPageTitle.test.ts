import assert from 'node:assert/strict';
import { test } from 'vitest';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';

test('completion cannot change the fixed Electron title', () => {
  Object.defineProperty(window, 'cloudcliDesktopUpdates', { configurable: true, value: {} });
  try {
    document.title = 'Old session';
    showCompletionTitleIndicator();
    assert.equal(document.title, 'CloudCLI');
  } finally {
    Reflect.deleteProperty(window, 'cloudcliDesktopUpdates');
  }
});
