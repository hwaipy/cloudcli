// Keep the macOS renderer alive when a window is closed, preserving its in-memory
// session store, drafts and scroll state. Explicit quit/update must still exit.
export function retainWindowOnClose(app, window, platform = process.platform) {
  let quitting = false;
  const allowQuit = () => { quitting = true; };
  const restore = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on('before-quit', allowQuit);
  app.on('activate', restore);
  app.on('second-instance', restore);
  window.on('close', event => {
    if (platform !== 'darwin' || quitting) return;
    event.preventDefault();
    window.hide();
  });
  return { allowQuit };
}
