import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import TerminalShortcutsPanel from '@/modules/shell/TerminalShortcutsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
let width = 1024;
let touchPoints = 0;
let coarsePointer = false;
let pointerChanges: EventTarget;

beforeEach(() => {
  width = 1024;
  touchPoints = 0;
  coarsePointer = false;
  pointerChanges = new EventTarget();
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, get: () => touchPoints });
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    get matches() { return query === '(any-pointer: coarse)' && coarsePointer; },
    media: query,
    onchange: null,
    addEventListener: pointerChanges.addEventListener.bind(pointerChanges),
    removeEventListener: pointerChanges.removeEventListener.bind(pointerChanges),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: pointerChanges.dispatchEvent.bind(pointerChanges),
  }));
});

afterEach(() => {
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  if (originalTouchPoints) Object.defineProperty(window.navigator, 'maxTouchPoints', originalTouchPoints);
  else Reflect.deleteProperty(window.navigator, 'maxTouchPoints');
});

const renderPanel = () => {
  const send = vi.fn();
  render(<TerminalShortcutsPanel
    wsRef={{ current: { readyState: WebSocket.OPEN, send } as unknown as WebSocket }}
    terminalRef={{ current: null }}
    isConnected
  />);
  return send;
};

test('wide iPads retain terminal shortcuts and send the expected control sequence', () => {
  touchPoints = 5;
  const send = renderPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
  assert.deepEqual(JSON.parse(send.mock.calls[0][0]), { type: 'input', data: '\x1b' });
});

test('wide pointer-only desktops do not show touch terminal controls', () => {
  renderPanel();
  assert.equal(screen.queryByRole('button', { name: 'Esc' }), null);
});

test('narrow layouts retain shortcuts and respond to iPad window resizing', () => {
  width = 600;
  renderPanel();
  assert.ok(screen.getByRole('button', { name: 'Tab' }));

  act(() => {
    width = 1024;
    window.dispatchEvent(new Event('resize'));
  });
  assert.equal(screen.queryByRole('button', { name: 'Tab' }), null);
});

test('coarse pointer capability enables controls independently of window width', () => {
  renderPanel();
  assert.equal(screen.queryByRole('button', { name: 'Esc' }), null);

  act(() => {
    coarsePointer = true;
    pointerChanges.dispatchEvent(new Event('change'));
  });
  assert.ok(screen.getByRole('button', { name: 'Esc' }));
});
