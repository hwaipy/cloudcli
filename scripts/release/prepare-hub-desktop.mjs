import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const destination = path.join(root, '.desktop-build/hub-app');
const electronVersion = require('electron/package.json').version;
const version = process.env.CLOUDCLI_DESKTOP_VERSION || '0.1.1';
const signedMac = process.platform === 'darwin' && (process.env.CLOUDCLI_DESKTOP_SIGNED === '1' || Boolean(process.env.CSC_NAME || process.env.CSC_LINK));
if (signedMac && !process.env.CSC_NAME) throw new Error('Signed Mac builds require CSC_NAME identifying the Developer ID Application certificate.');
if (signedMac && !process.env.APPLE_KEYCHAIN_PROFILE) throw new Error('Signed Mac builds require APPLE_KEYCHAIN_PROFILE for notarization; configure it with xcrun notarytool store-credentials.');
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid desktop version');
await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(path.join(destination, 'electron'), { recursive: true });
await fs.cp(path.join(root, 'electron/hub'), path.join(destination, 'electron/hub'), { recursive: true, filter: (name) => !name.includes('/tests') });
await fs.cp(path.join(root, 'electron/assets'), path.join(destination, 'electron/assets'), { recursive: true });
const pkg = {
  name: 'cloudcli-hub-desktop', version, description: 'CloudCLI desktop client', author: 'hwaipy',
  cloudcliUnsignedTest: process.platform === 'darwin' && !signedMac,
  productName: 'CloudCLI', type: 'module', main: 'electron/hub/main.mjs',
  dependencies: { 'electron-updater': require('electron-updater/package.json').version },
  build: {
    appId: 'cn.hwaipy.cloudcli.hub.desktop', productName: 'CloudCLI', asar: true,
    electronVersion, electronDist: path.join(root, 'node_modules/electron/dist'),
    directories: { output: '../../release/hub' }, files: ['electron/**', 'package.json'],
    artifactName: 'CloudCLI-Hub-${version}-${os}-${arch}.${ext}',
    publish: [{ provider: 'generic', url: process.env.CLOUDCLI_DESKTOP_UPDATE_URL || 'https://ai.hwaipy.cn/cloudcli-desktop/releases/' }],
    mac: {
      category: 'public.app-category.developer-tools', icon: 'electron/assets/logo-macos.icns', target: ['dir', 'zip', 'dmg'],
      hardenedRuntime: true,
      entitlements: 'electron/hub/entitlements.mac.plist',
      entitlementsInherit: 'electron/hub/entitlements.mac.plist',
      identity: signedMac ? process.env.CSC_NAME : null,
      forceCodeSigning: signedMac,
      notarize: signedMac,
    },
    win: { icon: 'electron/assets/logo-windows.ico', target: ['nsis'] },
    linux: { target: ['AppImage'], category: 'Development' },
  },
};
await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(pkg, null, 2));
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit' });
console.log(destination);
