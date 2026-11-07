// Finalize the distributable container before generating/publishing update hashes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version || '') || !process.env.CSC_NAME || !process.env.CSC_KEYCHAIN || !process.env.APPLE_KEYCHAIN_PROFILE) throw Error('Requires VERSION, CSC_NAME, CSC_KEYCHAIN and APPLE_KEYCHAIN_PROFILE');
const dmg = path.resolve(`release/hub/CloudCLI-Hub-${version}-mac-${process.arch}.dmg`);
const profile = ['--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE, '--keychain', process.env.APPLE_KEYCHAIN || process.env.CSC_KEYCHAIN];
execFileSync('codesign', ['--force', '--timestamp', '--keychain', process.env.CSC_KEYCHAIN, '--sign', process.env.CSC_NAME, dmg], { stdio: 'inherit' });
console.log('Submitting the signed DMG for Apple notarization…');
const submission = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', dmg, ...profile, '--wait', '--output-format', 'json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
console.log(JSON.stringify({ id: submission.id, status: submission.status }));
if (submission.status !== 'Accepted') throw Error('Apple did not accept the DMG; do not publish');
execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
execFileSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' });
// Stapling changes DMG bytes; the old block map/hash must never be published.
const info = await buildBlockMap(dmg, 'gzip', `${dmg}.blockmap`);
const metadataPath = path.resolve('release/hub/latest-mac.yml');
const metadata = yaml.load(await fs.readFile(metadataPath, 'utf8'));
if (metadata.version !== version) throw Error('Update metadata version does not match notarized DMG');
const entry = metadata.files.find(file => file.url === path.basename(dmg));
if (!entry) throw Error('DMG missing from update metadata');
entry.sha512 = info.sha512; entry.size = info.size;
await fs.writeFile(`${metadataPath}.next`, yaml.dump(metadata)); await fs.rename(`${metadataPath}.next`, metadataPath);
console.log('Notarized DMG, regenerated block map and update hashes are ready.');
