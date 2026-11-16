import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { isHubRuntime } from '@/shared/utils';

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const rawData = window.atob((base64String + '='.repeat((4 - base64String.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(rawData, value => value.charCodeAt(0));
}

// A newly registered backend scope must activate before PushManager.subscribe.
async function waitForActivation(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw Error('Notification service worker unavailable');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); worker.removeEventListener('statechange', check); if (error) reject(error); else resolve(); };
    const check = () => { if (worker.state === 'activated') finish(); else if (worker.state === 'redundant') finish(Error('Notification worker installation failed')); };
    const timer = setTimeout(() => finish(Error('Notification worker activation timed out')), 20_000);
    worker.addEventListener('statechange', check); check();
  });
}

/** Settings owns browser-only Web Push; backend scopes allow different VAPID keys. */
export function useWebPush(): WebPushState {
  // Permission belongs to this browser; the Electron bridge uses native delivery instead.
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof window === 'undefined' || 'cloudcliDesktopUpdates' in window || 'cloudcliDesktopNotifications' in window
    || !('Notification' in window) || !('serviceWorker' in navigator) ? 'unsupported' : Notification.permission);
  // Mirror the browser's actual subscriptions rather than an account-wide channel toggle.
  const [isSubscribed, setIsSubscribed] = useState(false);
  // Serializes explicit enable/disable actions while browser/server subscription state changes.
  const [isLoading, setIsLoading] = useState(false);
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/`;
  useEffect(() => {
    if (permission === 'unsupported') return;
    let cancelled = false;
    void navigator.serviceWorker.getRegistrations().then(async registrations => {
      const prefix = new URL(base, window.location.href).href;
      const owned = registrations.filter(registration => registration.scope === prefix || (registration.scope.startsWith(prefix) && /^push\/[^/]+\/$/.test(registration.scope.slice(prefix.length))));
      const subscriptions = await Promise.all(owned.map(registration => registration.pushManager.getSubscription()));
      if (!cancelled) setIsSubscribed(subscriptions.some(Boolean));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [base, permission]);

  const subscribe = useCallback(async () => {
    if (permission === 'unsupported') return;
    setIsLoading(true);
    try {
      const current = await Notification.requestPermission(); setPermission(current);
      if (current !== 'granted') return;
      const backends: string[] = [];
      if (isHubRuntime()) {
        const response = await api.hub.backends();
        if (!response.ok) throw Error('Cannot list notification backends');
        const data = await response.json() as { backends?: Array<{ id: string; online?: boolean }> };
        for (const backend of data.backends ?? []) if (backend.online !== false) backends.push(backend.id);
      } else backends.push('');
      if (!backends.length) throw Error('No online notification backend');
      for (const backend of backends) {
        const response = await api.settings.push.vapidPublicKey(backend || undefined);
        if (!response.ok) throw Error('Cannot load notification key');
        const { publicKey } = await response.json() as { publicKey: string };
        const registration = backend
          ? await navigator.serviceWorker.register(`${base}sw.js`, { scope: `${base}push/${encodeURIComponent(backend)}/` })
          : await navigator.serviceWorker.ready;
        await waitForActivation(registration);
        const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
        });
        const registered = await api.settings.push.subscribe(subscription.toJSON(), backend || undefined);
        if (!registered.ok) throw Error('Notification subscription was not accepted');
        setIsSubscribed(true);
      }
      // Retire the legacy app-wide subscription after every backend scope is ready.
      // Revoke it at the browser push provider; stale backend endpoints are pruned
      // on 410 delivery, avoiding the old API's account-wide channel disable.
      if (isHubRuntime()) {
        const root = (await navigator.serviceWorker.getRegistrations()).find(registration => registration.scope === new URL(base, window.location.href).href);
        const legacy = await root?.pushManager.getSubscription();
        if (legacy) await legacy.unsubscribe();
      }
    } catch (error) {
      console.error('Push subscribe failed:', error);
    } finally { setIsLoading(false); }
  }, [base, permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      const prefix = new URL(base, window.location.href).href;
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        if (registration.scope !== prefix && !(registration.scope.startsWith(prefix) && /^push\/[^/]+\/$/.test(registration.scope.slice(prefix.length)))) continue;
        const subscription = await registration.pushManager.getSubscription(); if (!subscription) continue;
        const suffix = registration.scope.slice(prefix.length);
        const backend = /^push\/([^/]+)\/$/.exec(suffix)?.[1];
        // Revoke locally even if an offline backend cannot remove its stale endpoint yet.
        await subscription.unsubscribe();
        try { await api.settings.push.unsubscribe(subscription.endpoint, backend ? decodeURIComponent(backend) : undefined); } catch {}
      }
      setIsSubscribed(false);
    } catch (error) { console.error('Push unsubscribe failed:', error); }
    finally { setIsLoading(false); }
  }, [base]);
  return { permission, isSubscribed, isLoading, subscribe, unsubscribe };
}
