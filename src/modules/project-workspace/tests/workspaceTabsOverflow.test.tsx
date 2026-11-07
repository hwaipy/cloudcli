import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { AppTab } from '@/shared/types';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
  PluginIcon: () => null,
}));

let resize: (() => void) | null = null;
vi.stubGlobal('ResizeObserver', class {
  constructor(callback: () => void) { resize = callback; }
  observe() {}
  disconnect() {}
});

afterEach(() => { resize = null; });

function TabsHarness() {
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  return <WorkspaceTabs activeTab={activeTab} setActiveTab={setActiveTab} shouldShowTasksTab={false} shouldShowBrowserTab={false} />;
}

test('tab strip becomes a dropdown only when its content exceeds the available width', () => {
  const view = render(<TabsHarness />);
  const container = view.container.firstElementChild as HTMLDivElement;
  const strip = container.firstElementChild as HTMLDivElement;
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 500 });
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 400 });
  act(() => resize?.());
  assert.equal(screen.queryByRole('button', { name: 'Workspace views' }), null);

  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
  act(() => resize?.());
  fireEvent.click(screen.getByRole('button', { name: 'Workspace views' }));
  assert.equal(screen.queryByRole('menuitemradio', { name: /Shell|Terminal/i }), null);
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Files/i }));
  assert.equal(screen.getByRole('button', { name: 'Workspace views' }).textContent?.includes('Files'), true);

  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 500 });
  act(() => resize?.());
  assert.equal(screen.queryByRole('button', { name: 'Workspace views' }), null);
});

test('strict workspace offers only chat and files even when host workflow flags are enabled', () => {
  render(<WorkspaceTabs activeTab="chat" setActiveTab={() => {}} containerOnly shouldShowTasksTab shouldShowBrowserTab />);
  const buttons = screen.getAllByRole('tab');
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => !/Shell|Terminal/i.test(button.textContent ?? '')));
  assert.ok(buttons.every((button) => !/Git|Tasks|Browser/i.test(button.textContent ?? '')));
});
