import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebUpdates } from './web-updates.mjs';
import { networkForwardingOptions } from './network-forwarding.mjs';
import { retainWindowOnClose } from './window-lifecycle.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = new URL(process.env.CLOUDCLI_DESKTOP_URL || 'https://ai.hwaipy.cn/cloudcli/');
if (!base.pathname.endsWith('/')) base.pathname += '/';
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) throw new Error('Desktop requires HTTPS or a loopback test server');
app.setName('CloudCLI');
if (process.env.CLOUDCLI_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.CLOUDCLI_DESKTOP_USER_DATA));
// Keep the existing profile and updater identity when renaming the application.
else app.setPath('userData', path.join(app.getPath('appData'), 'CloudCLI Hub'));
if (!app.requestSingleInstanceLock()) app.quit();
let lifecycle; let win; let updates; let timer; let checking; let shellUpdater;
let webState = { phase: 'idle' }; let shellState = { phase: 'idle' };
const getState = () => ({ web: webState, shell: shellState, version: app.getVersion(), packaged: app.isPackaged });
function publish() { if (win && !win.isDestroyed()) win.webContents.send('cloudcli-hub:update-state', getState()); }
function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === base.origin && url.pathname.startsWith(base.pathname); } catch { return false; }
}
function external(url) { if (/^(https?:|mailto:|tel:)/i.test(url)) void shell.openExternal(url); }
async function check() {
  if (checking) return checking;
  checking = (async () => {
    try { await updates.check(); } catch (error) { webState = { phase: 'error', error: error.message }; publish(); }
    if (shellUpdater) try { await shellUpdater.checkForUpdates(); } catch (error) { shellState = { phase: 'error', error: error.message }; publish(); }
    return getState();
  })().finally(() => { checking = null; });
  return checking;
}
async function apply() {
  if (webState.phase === 'downloading' || shellState.phase === 'downloading') throw new Error('更新仍在下载，请稍后重试。');
  if (!updates.pending && shellState.phase !== 'ready') throw new Error('No downloaded update is ready');
  await updates.apply();
  if (shellState.phase === 'ready') { lifecycle.allowQuit(); shellUpdater.quitAndInstall(false, true); return; }
  app.relaunch(); app.exit(0);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => clearInterval(timer));
app.whenReady().then(async () => {
const ses = session.defaultSession;
await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
  let allowed = false;
  try { allowed = new URL(details.requestingUrl || '').origin === base.origin && ['media', 'clipboard-sanitized-write', 'notifications'].includes(permission); } catch {}
  callback(allowed);
});
updates = new WebUpdates({ baseUrl: base.href, directory: path.join(app.getPath('userData'), 'web-cache'),
  fetch: (input, init) => ses.fetch(input, { ...init, bypassCustomProtocolHandlers: true }),
  onState: (state) => { webState = state; publish(); },
});
await ses.protocol.handle(base.protocol.slice(0, -1), async (request) => {
  if (request.method === 'GET') {
    // Chromium's navigation requests use destination=document; older versions
    // may omit it, so also recognize the top-level Accept header.
    const destination = request.destination || (request.headers.get('accept')?.includes('text/html') ? 'document' : '');
    const cached = await updates.response(request.url, destination);
    if (cached) return cached;
  }
  return ses.fetch(request.url, networkForwardingOptions(request, base.href));
});
win = new BrowserWindow({ width: 1280, height: 860, minWidth: 400, minHeight: 420, title: 'CloudCLI', backgroundColor: '#faf9f6',
  icon: path.join(root, '../assets/logo-macos.png'),
  webPreferences: { preload: path.join(root, 'preload.cjs'), additionalArguments: [`--cloudcli-hub-url=${base.href}`], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false },
});
lifecycle = retainWindowOnClose(app, win);
win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
win.webContents.on('will-navigate', (event, url) => { const target = new URL(url); if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) { event.preventDefault(); external(url); } });
win.webContents.on('will-attach-webview', (event) => event.preventDefault());
for (const [channel, handler] of Object.entries({
  'update-state': getState, 'check-updates': check, 'apply-update': apply,
})) ipcMain.handle(`cloudcli-hub:${channel}`, (event) => { if (!trusted(event)) throw new Error('Untrusted desktop request'); return handler(); });
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ label: 'CloudCLI', submenu: [{ role: 'about' }, { label: '检查更新', click: async () => { const state = await check(); await dialog.showMessageBox(win, { message: state.web.phase === 'ready' || state.shell.phase === 'ready' ? '更新已下载，可点击“更新并重启”。' : state.web.phase === 'downloading' || state.shell.phase === 'downloading' ? '更新正在后台下载。' : '更新检查完成。', detail: [state.web.error, state.shell.error].filter(Boolean).join('\n') }); } }, { label: '更新并重启', click: () => { if (updates.pending || shellState.phase === 'ready') void apply(); else void dialog.showMessageBox(win, { message: '当前没有已下载的更新。' }); } }, { type: 'separator' }, { role: 'quit' }] }] : []),
  { label: '文件', submenu: [{ role: 'close', accelerator: 'CmdOrCtrl+W' }] },
  { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
]));
await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>body{background:#faf9f6;display:grid;place-content:center;height:100vh;margin:0;font:20px system-ui;color:#333;text-align:center}small{font-size:13px;color:#888}</style><div>CloudCLI<br><small>正在准备界面资源…</small></div>'));
try { await updates.initialize(); webState = updates.pending ? { phase: 'ready' } : { phase: 'idle' }; }
catch (error) { webState = { phase: 'error', error: error.message }; }
await win.loadURL(base.href);
const unsignedMacTest = process.platform === 'darwin' && app.isPackaged && createRequire(import.meta.url)(path.join(app.getAppPath(), 'package.json')).cloudcliUnsignedTest;
if (unsignedMacTest) shellState = { phase: 'error', error: '本机测试包未签名，壳自动安装暂未启用；网页资源更新可正常使用。' };
if (app.isPackaged && !unsignedMacTest && process.env.CLOUDCLI_DESKTOP_DISABLE_SHELL_UPDATES !== '1') {
  const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
  shellUpdater = autoUpdater;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CLOUDCLI_DESKTOP_UPDATE_URL || 'https://ai.hwaipy.cn/cloudcli-desktop/releases/' });
  autoUpdater.on('update-available', () => { shellState = { phase: 'downloading', percent: 0 }; publish(); });
  autoUpdater.on('update-not-available', () => { shellState = { phase: 'idle' }; publish(); });
  autoUpdater.on('download-progress', (progress) => { shellState = { phase: 'downloading', percent: Math.round(progress.percent) }; publish(); });
  autoUpdater.on('update-downloaded', (info) => { shellState = { phase: 'ready', version: info.version }; publish(); });
  autoUpdater.on('error', (error) => { shellState = { phase: 'error', error: error.message }; publish(); });
}
void check(); timer = setInterval(() => void check(), 60_000);

}).catch((error) => { console.error("CloudCLI desktop startup failed", error); dialog.showErrorBox("CloudCLI", String(error.message || error)); app.quit(); });
