import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { retainWindowOnClose } from '../window-lifecycle.mjs';

function fixture(platform = 'darwin') {
  const app = new EventEmitter(); const window = new EventEmitter();
  Object.assign(window, { hidden: false, focused: false, minimized: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; }, show() { this.hidden = false; },
    hide() { this.hidden = true; }, focus() { this.focused = true; },
  });
  const lifecycle = retainWindowOnClose(app, window, platform);
  const close = () => { let prevented = false; window.emit('close', { preventDefault() { prevented = true; } }); return prevented; };
  return { app, window, lifecycle, close };
}
test('macOS close hides the existing window; activate/second-instance restore it', () => {
  const f = fixture();
  for (const event of ['activate', 'second-instance']) {
    assert.equal(f.close(), true); assert.equal(f.window.hidden, true);
    f.window.minimized = true; f.app.emit(event);
    assert.equal(f.window.hidden, false); assert.equal(f.window.minimized, false); assert.equal(f.window.focused, true);
  }
});
test('explicit quit and native update allow the retained window to close', () => {
  const quit = fixture(); quit.app.emit('before-quit'); assert.equal(quit.close(), false);
  const update = fixture(); update.lifecycle.allowQuit(); assert.equal(update.close(), false);
});
test('other platforms retain normal close behavior and destroyed windows cannot reopen', () => {
  assert.equal(fixture('win32').close(), false);
  const f = fixture(); f.window.destroyed = true; f.app.emit('activate'); assert.equal(f.window.focused, false);
});
