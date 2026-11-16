import { useEffect, useRef } from 'react';

import { useAuth } from '@/modules/auth';
import { api } from '@/shared/api';
import type { DesktopNotificationTarget, HubDesktopNotificationsBridge } from '@/shared/types';
import { getHubResourceBackend, isHubRuntime, registerHubResourceBackend } from '@/shared/utils';

/** Workspace owns one notification connection per backend, independently of selected chat. */
export function useDesktopNotifications(sessionId: string | null, navigate: (target: DesktopNotificationTarget) => void, backendId?: string) {
  const { user, token } = useAuth();
  const bridge = (window as Window & { cloudcliDesktopNotifications?: HubDesktopNotificationsBridge }).cloudcliDesktopNotifications;
  const account = user ? `${window.location.origin}:${user.id ?? user.username}` : '';
  // Delivery callbacks need the latest viewed session without reopening all sockets.
  const viewed = useRef({ sessionId, backendId });
  viewed.current = { sessionId, backendId };
  useEffect(() => {
    if (!bridge?.scope) return;
    let stopped = false; let enabled = false;
    const sockets = new Map<string, WebSocket>();
    const retries = new Set<ReturnType<typeof setTimeout>>();
    let endpoint = localStorage.getItem('cloudcli-desktop-notification-device');
    if (!endpoint) { endpoint = crypto.randomUUID(); localStorage.setItem('cloudcli-desktop-notification-device', endpoint); }
    const device = endpoint;
    const connect = async (id: string) => {
      if (stopped || !enabled || !token || sockets.has(id)) return;
      const socket = new WebSocket(api.desktopNotifications.socketUrl(token, id || undefined));
      sockets.set(id, socket);
      socket.onopen = async () => {
        try {
          const response = await api.desktopNotifications.register(device, true, id || undefined);
          if (!response.ok) throw Error('Notification registration failed');
          if (stopped || !enabled || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: 'register', deviceId: device, label: 'CloudCLI', platform: 'desktop' }));
        } catch { socket.close(); }
      };
      socket.onmessage = async event => {
        try {
          const message = JSON.parse(String(event.data));
          if (stopped || !enabled || message.type !== 'notification' || !message.payload) return;
          const sid = message.payload.data?.sessionId;
          if (typeof sid === 'string' && id) registerHubResourceBackend('session', sid, id);
          const target = viewed.current;
          await bridge.active({ sessionId: document.visibilityState === 'visible' ? target.sessionId : null,
            backendId: (target.sessionId ? getHubResourceBackend('session', target.sessionId) : null) ?? target.backendId ?? '' });
          if (stopped || !enabled) return;
          await bridge.receive({ backendId: id, id: message.id, payload: message.payload });
        } catch { /* A malformed frame must not interrupt later notifications. */ }
      };
      socket.onerror = () => { /* close owns reconnect */ };
      socket.onclose = () => {
        if (sockets.get(id) === socket) sockets.delete(id);
        if (stopped || !enabled) return;
        const retry = setTimeout(() => { retries.delete(retry); void connect(id); }, 3000);
        retries.add(retry);
      };
    };
    const discover = async () => {
      if (!enabled || stopped || !account || !token) return;
      try {
        if (!isHubRuntime()) { await connect(''); return; }
        const response = await api.hub.backends(); if (!response.ok) return;
        const data = await response.json() as { backends?: Array<{ id: string; online?: boolean }> };
        for (const backend of data.backends ?? []) if (backend.online !== false) void connect(backend.id);
      } catch { /* Retry discovery without logging credentials or payloads. */ }
    };
    const stopSockets = () => {
      for (const timer of retries) clearTimeout(timer); retries.clear();
      for (const socket of sockets.values()) socket.close(); sockets.clear();
    };
    const change = (state: { desktopNotifications: { enabled: boolean } }) => {
      const previous = enabled; enabled = Boolean(state.desktopNotifications.enabled && account && token);
      if (!enabled) {
        if (previous && !stopped) for (const id of sockets.keys()) void api.desktopNotifications.register(device, false, id || undefined).catch(() => {});
        stopSockets();
      } else void discover();
    };
    const unsubscribe = bridge.onStateUpdated(change);
    void bridge.scope(account).then(async state => {
      if (stopped) return;
      change(state);
      const target = viewed.current;
      await bridge.active({ sessionId: document.visibilityState === 'visible' ? target.sessionId : null,
        backendId: (target.sessionId ? getHubResourceBackend('session', target.sessionId) : null) ?? target.backendId ?? '' });
    }).catch(() => {});
    const timer = setInterval(() => void discover(), 30_000);
    return () => { stopped = true; clearInterval(timer); unsubscribe(); enabled = false; stopSockets(); };
  }, [account, bridge, token]);

  // Token refresh reconnects transport without clearing the same account's notifications.
  // A workspace unmount (including logout) must still remove its native account scope.
  useEffect(() => () => { if (bridge?.scope) void bridge.scope('').catch(() => {}); }, [bridge]);

  useEffect(() => {
    if (!bridge?.active) return;
    const sync = () => { void bridge.active({ sessionId: document.visibilityState === 'visible' ? sessionId : null, backendId: (sessionId ? getHubResourceBackend('session', sessionId) : null) ?? backendId ?? '' }).catch(() => {}); };
    sync(); window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [bridge, sessionId, account, backendId]);
  useEffect(() => bridge?.onNavigate?.(navigate), [bridge, navigate]);
}
