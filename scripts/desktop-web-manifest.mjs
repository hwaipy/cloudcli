import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Vite publishes the complete immutable asset graph for desktop background downloads. */
export async function writeDesktopManifest(directory) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && ['assets', 'icons'].includes(file.split('/')[0])) await visit(file);
      else if (entry.isFile() && !file.endsWith('.map') && (file.startsWith('assets/') || file.startsWith('icons/') || /^(index\.html|boot-assets\.json|manifest\.json|favicon\.[\w]+|logo[\w.-]*\.(png|svg|ico))$/.test(file))) files.push(file);
    }
  }
  await visit('');
  const assets = await Promise.all(files.sort().map(async (file) => {
    const data = await readFile(path.join(directory, file));
    return { file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  const id = createHash('sha256').update(JSON.stringify(assets)).digest('hex');
  await writeFile(path.join(directory, 'desktop-assets.json'), JSON.stringify({ format: 1, id, assets }));
}
