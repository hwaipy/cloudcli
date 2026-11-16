import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHubNotifications } from '../notifications.mjs';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-notifications-'));
  const window = new EventEmitter(); const notices = []; const badges = []; const navigations = [];
  Object.assign(window, { visible: false, focused: false, isVisible() { return this.visible; }, isFocused() { return this.focused; }, isMinimized: () => false, show() { this.visible = true; }, focus() { this.focused = true; this.emit('focus'); } });
  class Notification extends EventEmitter { static isSupported() { return true; } constructor(options) { super(); this.options = options; notices.push(this); } show() {} close() { this.emit('close'); } }
  const args = { file: path.join(root, 'notifications.json'), app: { setBadgeCount(count) { badges.push(count); } }, window, Notification, onState() {}, onNavigate(target) { navigations.push(target); } };
  const controller = await createHubNotifications(args);
  try { await run({ controller, window, notices, badges, navigations, args }); }
  finally { await controller.flush(); await fs.rm(root, { recursive: true, force: true }); }
}
const message = (backendId = 'one', sessionId = 'session', id = 'event') => ({ backendId, id, payload: { title: 'Test session', body: 'Private notification body', data: { sessionId, provider: 'codex' } } });
test('disabled by default; hidden window receives notifications and counts distinct backend/session identities', () => fixture(async ({ controller, notices, badges }) => {
  await controller.scope('account-a'); assert.equal(await controller.receive(message()), false);
  await controller.update({ enabled: true });
  await controller.receive(message()); await controller.receive(message());
  await controller.receive(message('one', 'session', 'next')); assert.equal(badges.at(-1), 1);
  await controller.receive(message('two')); assert.equal(badges.at(-1), 2); assert.equal(notices.length, 3);
}));
test('viewing clears only the focused visible session and suppresses notifications for that session', () => fixture(async ({ controller, window, badges, notices }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  await controller.receive(message()); await controller.receive(message('two'));
  controller.active({ backendId: 'one', sessionId: 'session' }); assert.equal(badges.at(-1), 2);
  window.show(); window.focus(); assert.equal(badges.at(-1), 1);
  assert.equal(await controller.receive(message('one', 'session', 'later')), false);
  assert.equal(notices.length, 2);
}));
test('click restores the window and navigates by identity; prior-account notifications cannot navigate', () => fixture(async ({ controller, window, notices, navigations }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  await controller.receive(message()); notices[0].emit('click');
  assert.equal(window.visible, true); assert.equal(navigations[0].backendId, 'one');
  await controller.scope('account-b'); notices[0].emit('click'); assert.equal(navigations.length, 1);
  assert.equal(controller.state().desktopNotifications.enabled, false);
}));
test('settings/unread state survive restart without storing message body or credentials; logout clears Dock badge', () => fixture(async ({ controller, args, badges }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true }); await controller.receive(message());
  await controller.flush(); const saved = await fs.readFile(args.file, 'utf8'); assert.ok(!saved.includes('Private notification body'));
  const restored = await createHubNotifications(args); await restored.scope('account-a');
  assert.equal(restored.state().desktopNotifications.unreadCount, 1); await restored.scope(''); assert.equal(badges.at(-1), 0);
}));
test('legacy session tags can notify again in later turns', () => fixture(async ({ controller, notices }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  const original = Date.now; let now = original(); Date.now = () => now;
  try { await controller.receive(message()); now += 3000; await controller.receive(message()); assert.equal(notices.length, 2); }
  finally { Date.now = original; }
}));
test('logout during asynchronous persistence cannot show a prior-account notification', () => fixture(async ({ controller, notices, badges }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  const receiving = controller.receive(message()); await controller.scope('account-b'); await receiving;
  assert.equal(notices.length, 0); assert.equal(badges.at(-1), 0);
}));
test('visible but unfocused window notifies again immediately after the previous turn was read', () => fixture(async ({ controller, window, badges, notices }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  window.show(); window.focused = false;
  controller.active({ backendId: 'one', sessionId: 'session' });
  await controller.receive(message('one', 'session', 'turn-event-one'));
  assert.equal(badges.at(-1), 1); assert.equal(notices.length, 1);
  window.focus(); assert.equal(badges.at(-1), 0);
  window.focused = false;
  await controller.receive(message('one', 'session', 'turn-event-two'));
  assert.equal(badges.at(-1), 1); assert.equal(notices.length, 2);
}));
test('mark all read clears persisted badge without disabling future notifications', () => fixture(async ({ controller, badges, args }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  await controller.receive(message()); await controller.receive(message('two'));
  await controller.update({ clearUnread: true });
  assert.equal(badges.at(-1), 0);
  assert.equal(controller.state().desktopNotifications.enabled, true);
  const restored = await createHubNotifications(args); await restored.scope('account-a');
  assert.equal(restored.state().desktopNotifications.unreadCount, 0);
  await controller.receive(message('one', 'session', 'new-turn')); assert.equal(badges.at(-1), 1);
}));
test('archiving read targets clears only the matching backend and disabling clears stale badges', () => fixture(async ({ controller, badges }) => {
  await controller.scope('account-a'); await controller.update({ enabled: true });
  await controller.receive(message()); await controller.receive(message('two'));
  await controller.update({ readSessions: [{ backendId: 'one', sessionId: 'session' }] });
  assert.equal(badges.at(-1), 1);
  await controller.update({ enabled: false }); assert.equal(badges.at(-1), 0);
}));
test('legacy duplicate unread identities are normalized before restoring the Dock badge', () => fixture(async ({ controller, args, badges }) => {
  await controller.flush();
  await fs.writeFile(args.file, JSON.stringify({ 'account-a': { enabled: true, unread: ['one\u0000session', 'one\u0000session', 'invalid'] } }));
  const restored = await createHubNotifications(args);
  await restored.scope('account-a');
  assert.equal(badges.at(-1), 1);
  await restored.update({ clearUnread: true });
}));
