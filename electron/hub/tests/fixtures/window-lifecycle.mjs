// Real Electron regression: close and reopen exactly the same renderer, then quit.
import { app, BrowserWindow, Menu } from 'electron';
import assert from 'node:assert/strict';
import { retainWindowOnClose } from '../../window-lifecycle.mjs';
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  retainWindowOnClose(app, window, 'darwin');
  await window.loadURL('data:text/html,<title>CloudCLI</title><input id="draft"><div style="height:4000px"></div>');
  window.show();
  await window.webContents.executeJavaScript(`window.cacheProbe = { session: 'same-object' }; document.querySelector('input').value = 'unsent draft'; window.scrollTo(0, 400);`);
  const id = window.webContents.id;
  const closeItem = { id: 'close-window', role: 'close', accelerator: 'CmdOrCtrl+W' };
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [closeItem] }]));
  assert.equal(Menu.getApplicationMenu().getMenuItemById('close-window').accelerator, 'CmdOrCtrl+W');
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), false);
  app.emit('activate');
  assert.equal(window.isVisible(), true);
  assert.equal(window.webContents.id, id);
  const snapshot = await window.webContents.executeJavaScript(`({ session: window.cacheProbe.session, draft: document.querySelector('input').value, scroll: window.scrollY })`);
  assert.deepEqual(snapshot, { session: 'same-object', draft: 'unsent draft', scroll: 400 });
  window.close(); app.emit('second-instance'); assert.equal(window.isVisible(), true);
  console.log('CLOSE_REOPEN_RETAINS_RENDERER_DRAFT_SCROLL_OK');
  app.on('will-quit', () => console.log('EXPLICIT_QUIT_OK'));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
