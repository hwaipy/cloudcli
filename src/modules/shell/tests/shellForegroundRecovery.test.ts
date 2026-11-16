import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import type { Project, ProjectSession } from '@/shared/types';

vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() { FakeSocket.instances.push(this); }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  output(data: string) { this.onmessage?.({ data: JSON.stringify({ type: 'output', data }) }); }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function renderConnection(autoConnect = false, initialCommand: string | null = null) {
  let screen = '';
  const write = vi.fn((data: string) => { screen += data; });
  const clearTerminalScreen = vi.fn(() => { screen = ''; });
  const wsRef = ref<WebSocket | null>(null);
  const options = {
    wsRef,
    terminalRef: ref({ write, cols: 80, rows: 24 } as unknown as Terminal | null),
    fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
    selectedProjectRef: ref<Project | null | undefined>({ fullPath: '/projects/cloudcli' } as Project),
    selectedSessionRef: ref<ProjectSession | null | undefined>({ id: 'session-1' } as ProjectSession),
    initialCommandRef: ref<string | null | undefined>(initialCommand),
    isPlainShellRef: ref(false),
    bypassPermissionsRef: ref(false),
    isDarkModeRef: ref(true),
    onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
    isInitialized: true,
    autoConnect,
    closeSocket: vi.fn(() => { wsRef.current?.close(); wsRef.current = null; }),
    clearTerminalScreen,
  };
  const view = renderHook(() => useShellConnection(options));
  return { view, clearTerminalScreen, screen: () => screen };
}

const socket = (index: number) => FakeSocket.instances[index]!;
const resume = () => act(() => {
  window.dispatchEvent(new Event('cloudcli:resume'));
  vi.advanceTimersByTime(0);
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a manually connected terminal reattaches its original PTY without replaying output twice', () => {
  const fixture = renderConnection(false);
  act(() => fixture.view.result.current.connectToShell({ forceRestart: true }));
  act(() => {
    socket(0).open();
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
    socket(0).output('retained output');
  });
  expect(JSON.parse(socket(0).sent[0]!).forceRestart).toBe(true);
  const lateMessage = socket(0).onmessage;
  const lateClose = socket(0).onclose;

  act(() => {
    window.dispatchEvent(new Event('cloudcli:resume'));
    window.dispatchEvent(new Event('cloudcli:resume'));
    vi.advanceTimersByTime(0);
  });
  expect(FakeSocket.instances).toHaveLength(2);
  expect(socket(0).readyState).toBe(FakeSocket.CLOSED);
  expect(fixture.clearTerminalScreen).toHaveBeenCalledTimes(1);
  expect(fixture.screen()).toBe('');
  act(() => {
    socket(1).open();
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
    socket(1).output('retained output');
    lateMessage?.({ data: JSON.stringify({ type: 'output', data: 'obsolete output' }) });
    lateClose?.();
  });
  expect(socket(1).sent).toHaveLength(1);
  expect(JSON.parse(socket(1).sent[0]!)).toMatchObject({
    type: 'init', projectPath: '/projects/cloudcli', sessionId: 'session-1', forceRestart: false,
  });
  expect(fixture.screen()).toBe('retained output');
  expect(fixture.view.result.current.isConnected).toBe(true);
});

test('foreground recovery cancels an obsolete delayed init before attaching the replacement socket', () => {
  const { view } = renderConnection(false);
  act(() => view.result.current.connectToShell());
  act(() => socket(0).open());
  resume();
  act(() => {
    socket(1).open();
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
  });
  expect(socket(0).sent).toEqual([]);
  expect(socket(1).sent).toHaveLength(1);
});

test('a suspended handshake is replaced with exactly one new connection', () => {
  const { view } = renderConnection(false);
  act(() => view.result.current.connectToShell());
  expect(view.result.current.isConnecting).toBe(true);
  resume();
  expect(FakeSocket.instances).toHaveLength(2);
  expect(socket(0).readyState).toBe(FakeSocket.CLOSED);
  act(() => {
    socket(1).open();
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
  });
  expect(socket(1).sent).toHaveLength(1);
});

test('foreground recovery does not open a terminal the user has not connected', () => {
  renderConnection(false);
  resume();
  expect(FakeSocket.instances).toHaveLength(0);
});

test('a deliberate disconnect stays disconnected across foreground recovery', () => {
  const { view } = renderConnection(true);
  act(() => socket(0).open());
  act(() => view.result.current.disconnectFromShell({ suppressAutoConnect: true }));
  resume();
  act(() => { vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS); });
  expect(FakeSocket.instances).toHaveLength(1);
  expect(socket(0).sent).toEqual([]);
  expect(view.result.current.isConnected).toBe(false);
});

test('manual disconnection with auto-connect disabled also clears the resume intent', () => {
  const { view } = renderConnection(false);
  act(() => view.result.current.connectToShell());
  act(() => socket(0).open());
  act(() => view.result.current.disconnectFromShell());
  resume();
  expect(FakeSocket.instances).toHaveLength(1);
});

test('foreground recovery does not restart a server login command', () => {
  const { view } = renderConnection(false, 'claude setup-token');
  act(() => view.result.current.connectToShell());
  act(() => socket(0).open());
  resume();
  expect(FakeSocket.instances).toHaveLength(1);
  expect(socket(0).readyState).toBe(FakeSocket.OPEN);
});

test('unmount cancels both queued recovery and delayed init', () => {
  const { view } = renderConnection(false);
  act(() => view.result.current.connectToShell());
  act(() => socket(0).open());
  act(() => { window.dispatchEvent(new Event('cloudcli:resume')); });
  view.unmount();
  act(() => {
    window.dispatchEvent(new Event('cloudcli:resume'));
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
  });
  expect(FakeSocket.instances).toHaveLength(1);
  expect(socket(0).sent).toEqual([]);
});
