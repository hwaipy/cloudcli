import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { receiveSessionInputEvent, scopeSessionInputStatus } from '@/shared/context/SessionInputStatus';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM, getHubBackendId, getHubRequestBackend, isHubRuntime, registerHubResourceBackend, withHubBackendUrl } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  /** True means the frame reached the local socket; it does not acknowledge server admission. */
  sendMessage: (message: unknown) => boolean;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on a token refresh, reports `connecting` until the new
   * one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return withHubBackendUrl(`${protocol}//${window.location.host}/ws`); // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return withHubBackendUrl(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`); // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const backendSocketsRef = useRef(new Map<string, WebSocket>());
  const defaultBackendRef = useRef<string | null>(getHubBackendId());
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  useEffect(() => { scopeSessionInputStatus(user ? String(user.id ?? user.username) : ""); }, [user]);

  const dispatch = useCallback((event: ServerEvent) => {
    receiveSessionInputEvent(event as unknown as Record<string, unknown>);
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Keep backend transports alive independently; selecting projects never
  // tears down another backend's streaming turn or the workspace itself.
  useEffect(() => {
    if (!isHubRuntime() || isAuthLoading || !user || !token) return;
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const connectBackend = (backendId: string) => {
      if (disposed || backendSocketsRef.current.has(backendId)) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(withHubBackendUrl(
        `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`, backendId,
      ));
      backendSocketsRef.current.set(backendId, socket);
      socket.onopen = () => {
        if (!wsRef.current || backendId === defaultBackendRef.current) wsRef.current = socket;
        setConnectionStatus('connected');
        dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
      };
      socket.onmessage = (frame) => {
        try {
          const event = JSON.parse(frame.data) as ServerEvent;
          if (typeof event.sessionId === 'string') registerHubResourceBackend('session', event.sessionId, backendId);
          dispatch({ ...event, __hubBackendId: backendId } as ServerEvent);
        } catch (error) { console.error('Backend WebSocket event failed:', error); }
      };
      socket.onclose = () => {
        backendSocketsRef.current.delete(backendId);
        if (wsRef.current === socket) wsRef.current = [...backendSocketsRef.current.values()].find((other) => other.readyState === WebSocket.OPEN) ?? null;
        setConnectionStatus([...backendSocketsRef.current.values()].some((other) => other.readyState === WebSocket.OPEN) ? 'connected' : 'disconnected');
        if (disposed) return;
        const timer = setTimeout(() => { timers.delete(timer); connectBackend(backendId); }, 3000);
        timers.add(timer);
      };
      socket.onerror = () => { /* onclose owns reconnect and retry timing. */ };
    };
    const discover = async () => {
      try {
        const response = await fetch('/hub/backends', { cache: 'no-store' });
        if (!response.ok || disposed) return;
        const payload = await response.json() as { defaultBackendId?: string; selectedBackendId?: string; backends?: Array<{ id: string; online?: boolean }> };
        if (disposed) return;
        defaultBackendRef.current ??= payload.defaultBackendId ?? payload.selectedBackendId ?? null;
        for (const backend of payload.backends ?? []) {
          if (backend.online !== false) connectBackend(backend.id);
        }
      } catch (error) { console.warn('Hub backend connection discovery failed:', error); }
    };
    void discover();
    const interval = setInterval(() => { void discover(); }, 30000);
    return () => {
      disposed = true;
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      for (const socket of backendSocketsRef.current.values()) {
        socket.onclose = null; socket.onmessage = null; socket.onopen = null; socket.onerror = null;
        socket.close();
      }
      backendSocketsRef.current.clear();
    };
  }, [dispatch, isAuthLoading, token, user]);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (isHubRuntime()) return; // Every Hub socket is explicitly owned by a backend.
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setConnectionStatus('connected');
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch({ ...data, __hubBackendId: defaultBackendRef.current ?? undefined } as ServerEvent);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a token refresh never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      // What comes next is a socket with a refreshed token, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const frame = message as { type?: string; sessions?: Array<{ sessionId?: string }> };
    if (isHubRuntime() && frame.type === 'chat.subscribe' && Array.isArray(frame.sessions)) {
      const groups = new Map<string, Array<{ sessionId?: string }>>();
      for (const session of frame.sessions) {
        const owner = getHubRequestBackend('/ws', JSON.stringify({ sessionId: session.sessionId }));
        if (!owner) return false;
        groups.set(owner, [...(groups.get(owner) ?? []), session]);
      }
      for (const owner of groups.keys()) {
        if (backendSocketsRef.current.get(owner)?.readyState !== WebSocket.OPEN) return false;
      }
      try {
        for (const [owner, sessions] of groups) backendSocketsRef.current.get(owner)!.send(JSON.stringify({ ...frame, sessions }));
        return groups.size > 0;
      } catch { return false; }
    }

    const backendId = getHubRequestBackend('/ws', JSON.stringify(message));
    const socket = isHubRuntime()
      ? (backendId ? backendSocketsRef.current.get(backendId) : undefined)
      : wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        console.error('WebSocket send failed:', error);
      }
    }
    console.warn('WebSocket not connected');
    return false;
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
  }), [sendMessage, subscribe, connectionStatus]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
