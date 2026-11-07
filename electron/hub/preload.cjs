const { contextBridge, ipcRenderer } = require('electron');
// The trusted main process pins this URL in BrowserWindow.additionalArguments.
// Synchronous exposure also lets the shared React entry skip PWA registration.
const argument = process.argv.find((value) => value.startsWith('--cloudcli-hub-url='));
let allowed = false;
try {
  const configured = new URL(argument?.slice('--cloudcli-hub-url='.length));
  allowed = window.location.origin === configured.origin && window.location.pathname.startsWith(configured.pathname);
} catch {}
if (allowed) {
  contextBridge.exposeInMainWorld('cloudcliDesktopUpdates', {
    state: () => ipcRenderer.invoke('cloudcli-hub:update-state'),
    check: () => ipcRenderer.invoke('cloudcli-hub:check-updates'),
    apply: () => ipcRenderer.invoke('cloudcli-hub:apply-update'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('cloudcli-hub:update-state', listener);
      return () => ipcRenderer.removeListener('cloudcli-hub:update-state', listener);
    },
  });
}
