// Local Developer ID build entry. Credentials remain in a dedicated keychain;
// its password is read from a private file outside the repository, never logged.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = process.argv[2];
if (process.platform !== 'darwin' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version || '')) throw Error('Usage on Mac: node scripts/release/build-signed-hub.mjs VERSION [--check-only]');
const directory = path.join(os.homedir(), '.config/cloudcli-signing');
const keychain = process.env.CSC_KEYCHAIN || path.join(directory, 'cloudcli-signing.keychain-db');
const password = await fs.readFile(process.env.CLOUDCLI_SIGNING_KEYCHAIN_PASSWORD_FILE || path.join(directory, 'signing-keychain.password'), 'utf8');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'cloudcli-notary';
let builder; let timer; let maintenanceError;
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; });
    // Do not propagate child-process errors containing the full secret argv.
    child.stderr.resume(); child.on('error', () => reject(Error(`${binary} could not start`)));
    child.on('close', code => code === 0 ? resolve(output) : reject(Error(`${binary} failed (${code}); check local keychain access/credentials`)));
  });
}
const unlock = () => run('security', ['unlock-keychain', '-p', password, keychain]);
const interrupt = () => { builder?.kill('SIGTERM'); };
try {
  await unlock();
  const identities = await run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  const matches = [...identities.matchAll(/"Developer ID Application: ([^"]+)"/g)].map(match => match[1]);
  const identity = process.env.CSC_NAME || (matches.length === 1 ? matches[0] : null);
  if (!identity) throw Error('Choose a valid Developer ID Application identity with CSC_NAME');
  await run('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--keychain', keychain, '--output-format', 'json']);
  console.log('Developer ID identity and notarization credentials verified.');
  if (!process.argv.includes('--check-only')) {
    timer = setInterval(() => void unlock().catch(error => { maintenanceError = error; interrupt(); }), 45_000);
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const code = await new Promise((resolve, reject) => {
      builder = spawn('npm', ['run', 'desktop:hub:dist'], {
        cwd: root, stdio: 'inherit', env: { ...process.env, CLOUDCLI_DESKTOP_SIGNED: '1', CLOUDCLI_DESKTOP_VERSION: version,
          CSC_NAME: identity, CSC_KEYCHAIN: keychain, APPLE_KEYCHAIN: keychain, APPLE_KEYCHAIN_PROFILE: profile },
      });
      builder.once('error', reject); builder.once('close', resolve);
    });
    if (maintenanceError) throw maintenanceError;
    if (code !== 0) throw Error(`Signed build failed (${code})`);
    const finalCode = await new Promise((resolve, reject) => {
      builder = spawn(process.execPath, ['scripts/release/notarize-hub-dmg.mjs', version], {
        cwd: root, stdio: 'inherit', env: { ...process.env, CSC_NAME: identity, CSC_KEYCHAIN: keychain,
          APPLE_KEYCHAIN: keychain, APPLE_KEYCHAIN_PROFILE: profile },
      });
      builder.once('error', reject); builder.once('close', resolve);
    });
    if (finalCode !== 0) throw Error(`DMG notarization failed (${finalCode})`);
  }
} finally {
  clearInterval(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  await run('security', ['lock-keychain', keychain]);
}
