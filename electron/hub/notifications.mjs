import fs from 'node:fs/promises';
import path from 'node:path';

// Main-process state is account-scoped. Only unread identities/settings persist;
// notification bodies and authentication tokens never enter this file.
export async function createHubNotifications({ file, app, window, Notification, onState, onNavigate }) {
  let saved = Object.create(null);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [id, value] of Object.entries(data)) if (value && typeof value.enabled === 'boolean' && Array.isArray(value.unread)) {
        saved[id] = { enabled: value.enabled, unread: [...new Set(value.unread.filter(key => typeof key === 'string' && key.includes('\u0000')))].slice(0, 10000) };
      }
    }
  } catch {}
  let account = ''; let active = ''; let generation = 0; let pendingWrite = Promise.resolve();
  const shown = new Map(); const live = new Set();
  const entry = () => saved[account] || { enabled: false, unread: [] };
  const key = (backend, session) => `${backend}\u0000${session}`;
  const state = () => ({ desktopNotifications: { enabled: Boolean(account && entry().enabled), supported: Notification.isSupported(), canClearUnread: true, unreadCount: account ? entry().unread.length : 0 } });
  const persist = () => {
    const data = JSON.stringify(saved); pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.next`, data, { mode: 0o600 }); await fs.rename(`${file}.next`, file);
    }); return pendingWrite;
  };
  const publish = () => { app.setBadgeCount(state().desktopNotifications.unreadCount); onState(state()); };
  const clearRead = () => {
    if (!account || !active || !window.isVisible() || !window.isFocused()) return;
    const current = entry(); const unread = current.unread.filter(value => value !== active);
    if (unread.length !== current.unread.length) { saved[account] = { ...current, unread }; void persist(); publish(); }
  };
  window.on('focus', clearRead);
  return {
    state,
    async scope(value) {
      const next = typeof value === 'string' ? value.slice(0, 200) : '';
      if (account !== next) {
        generation++; account = next; active = ''; shown.clear();
        for (const notification of live) notification.close(); live.clear();
        if (account && !saved[account]) saved[account] = { enabled: false, unread: [] };
      }
      publish(); return state();
    },
    async update(input) {
      if (!account || !input || (typeof input.enabled !== 'boolean' && input.clearUnread !== true && !Array.isArray(input.readSessions))) throw Error('Sign in before changing notifications');
      const current = entry();
      const read = new Set((input.readSessions || []).filter(item => typeof item?.sessionId === 'string' && typeof item?.backendId === 'string').map(item => key(item.backendId, item.sessionId)));
      saved[account] = { enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
        unread: input.clearUnread === true || input.enabled === false ? [] : current.unread.filter(identity => !read.has(identity)) };
      if (input.clearUnread === true || input.enabled === false) { for (const notification of live) notification.close(); live.clear(); }
      await persist(); publish(); return state();
    },
    active(input) {
      active = typeof input?.sessionId === 'string' ? key(String(input.backendId || ''), input.sessionId) : '';
      clearRead();
    },
    async receive(input) {
      if (!account || !entry().enabled) return false;
      const backend = typeof input?.backendId === 'string' ? input.backendId.slice(0, 200) : '';
      const payload = input?.payload; const session = payload?.data?.sessionId;
      if (!payload || typeof payload.title !== 'string' || typeof session !== 'string' || !session || session.length > 200) return false;
      const identity = key(backend, session);
      const eventId = typeof input.id === 'string' ? `${backend}:${input.id}` : null;
      // Older servers identify events by a reusable session/code tag. Deduplicate
      // only adjacent delivery, never suppress all future turns of that session.
      if (eventId && Date.now() - (shown.get(eventId) ?? 0) < 2000) return false;
      if (eventId) { shown.set(eventId, Date.now()); if (shown.size > 1000) shown.delete(shown.keys().next().value); }
      if (active === identity && window.isVisible() && window.isFocused()) return false;
      if (!entry().unread.includes(identity)) saved[account] = { ...entry(), unread: [...entry().unread, identity] };
      const owner = account; const epoch = generation;
      publish(); await persist();
      if (owner !== account || epoch !== generation || !entry().enabled) return false;
      if (active === identity && window.isVisible() && window.isFocused()) { clearRead(); return false; }
      if (!Notification.isSupported()) return true;
      const notification = new Notification({ title: payload.title.slice(0, 200), body: String(payload.body || '').slice(0, 1000) });
      live.add(notification); notification.on('close', () => live.delete(notification));
      notification.on('click', () => {
        if (account !== owner || generation !== epoch) return;
        if (window.isMinimized()) window.restore(); window.show(); window.focus();
        const current = entry();
        saved[account] = { ...current, unread: current.unread.filter(value => value !== identity) };
        void persist(); publish();
        onNavigate({ sessionId: session, backendId: backend, provider: typeof payload.data.provider === 'string' ? payload.data.provider : null });
      });
      notification.show(); return true;
    },
    flush: () => pendingWrite,
  };
}
