import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { getHubResourceBackend } from '@/shared/utils';
import type { Project, ProjectSession } from '@/shared/types';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '@/modules/shell/utils/socket';
import { readSelectedProvider } from '@/shared/selectedProvider';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  bypassPermissionsRef: MutableRefObject<boolean>;
  isDarkModeRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  claudeLaunchColorScheme: 'light' | 'dark' | null;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

/** Used by useShellRuntime to connect terminal UI to a retained server-side PTY. */
export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  bypassPermissionsRef,
  isDarkModeRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  // Drives the terminal's connected controls independently of a stale WebKit socket state.
  const [isConnected, setIsConnected] = useState(false);
  // Disables duplicate connection attempts while the transport is handshaking.
  const [isConnecting, setIsConnecting] = useState(false);
  // The theme the server says the Claude CLI in this pty was launched for. Only
  // the server knows it: a reconnect can reattach to a CLI started in another
  // theme. Null when the pty runs anything else or no socket is open.
  const [claudeLaunchColorScheme, setClaudeLaunchColorScheme] = useState<'light' | 'dark' | null>(null);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  const wantsConnectionRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const initTimerRef = useRef<number | null>(null);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'error') {
        // The server sends this instead of spawning a PTY, then keeps the
        // socket open — so without writing it out the terminal just stays
        // blank forever under a green "connected" dot. Deliberately not
        // closing the socket: `onclose` clears the screen and would erase
        // the very message being surfaced here.
        const detail = typeof message.message === 'string' && message.message
          ? message.message
          : 'Shell error';
        terminalRef.current?.write(`\r\n\x1b[31m${detail}\x1b[0m\r\n`);
        return;
      }

      if (message.type === 'claude_theme') {
        const { colorScheme } = message;
        setClaudeLaunchColorScheme(colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : null);
      }
    },
    [handleProcessCompletion, onOutputRef, terminalRef],
  );

  const connectWebSocket = useCallback(
    () => {
      const currentSocket = wsRef.current;
      if (connectingRef.current || (currentSocket && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN))) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl(selectedProjectRef.current?.__hubBackendId ?? getHubResourceBackend('project', selectedProjectRef.current?.projectId) ?? undefined);
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;
        const generation = ++connectionGenerationRef.current;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (connectionGenerationRef.current !== generation) return;
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          initTimerRef.current = window.setTimeout(() => {
            initTimerRef.current = null;
            if (connectionGenerationRef.current !== generation || socket.readyState !== WebSocket.OPEN) return;
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || readSelectedProvider()),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceRestart,
              // Launch-time flag: bypass mode can only join the CLI's
              // shift+tab cycle when claude starts with it.
              bypassPermissions: bypassPermissionsRef.current,
              // Launch-time too: a CLI picks its colours when it starts.
              colorScheme: isDarkModeRef.current ? 'dark' : 'light',
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (connectionGenerationRef.current !== generation) return;
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (connectionGenerationRef.current !== generation) return;
          if (initTimerRef.current !== null) window.clearTimeout(initTimerRef.current);
          initTimerRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
          setClaudeLaunchColorScheme(null);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (connectionGenerationRef.current !== generation) return;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      bypassPermissionsRef,
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isDarkModeRef,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    wantsConnectionRef.current = true;
    setIsConnecting(true);
    connectWebSocket();
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    wantsConnectionRef.current = false;
    connectionGenerationRef.current += 1;
    if (initTimerRef.current !== null) window.clearTimeout(initTimerRef.current);
    initTimerRef.current = null;
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    setClaudeLaunchColorScheme(null);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  useEffect(() => {
    let resumeTimer: number | null = null;
    const handleResume = () => {
      if (!isInitialized || !wantsConnectionRef.current || suppressAutoConnectRef.current || resumeTimer !== null) return;
      // Login-command init deliberately restarts its process on the server.
      // Leave these explicit authentication flows under the user's control.
      const command = initialCommandRef.current ?? '';
      if (command.includes('setup-token') || command.includes('cursor-agent login') || command.includes('auth login')) return;
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        if (!wantsConnectionRef.current || suppressAutoConnectRef.current) return;
        connectionGenerationRef.current += 1;
        if (initTimerRef.current !== null) window.clearTimeout(initTimerRef.current);
        initTimerRef.current = null;
        const oldSocket = wsRef.current;
        if (oldSocket) {
          oldSocket.onopen = null;
          oldSocket.onmessage = null;
          oldSocket.onclose = null;
          oldSocket.onerror = null;
          oldSocket.close();
          wsRef.current = null;
        }
        // The server replays the retained PTY buffer on init. Clear the old
        // viewport first so reconnecting never appends a second copy of it.
        clearTerminalScreen();
        forceRestartOnInitRef.current = false;
        connectingRef.current = false;
        setIsConnected(false);
        setIsConnecting(true);
        setClaudeLaunchColorScheme(null);
        connectWebSocket();
      }, 0);
    };
    window.addEventListener('cloudcli:resume', handleResume);
    return () => {
      window.removeEventListener('cloudcli:resume', handleResume);
      if (resumeTimer !== null) window.clearTimeout(resumeTimer);
    };
  }, [clearTerminalScreen, connectWebSocket, initialCommandRef, isInitialized, wsRef]);

  useEffect(() => () => {
    connectionGenerationRef.current += 1;
    if (initTimerRef.current !== null) window.clearTimeout(initTimerRef.current);
  }, []);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    claudeLaunchColorScheme,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
