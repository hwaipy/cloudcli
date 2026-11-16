import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { transform } from 'esbuild';

test('production CSS has no malformed selectors after Tailwind variant generation', async () => {
  const source = await readFile('src/index.css', 'utf8');
  const result = await postcss([tailwind(), autoprefixer()]).process(source, { from: 'src/index.css' });
  const minified = await transform(result.css, { loader: 'css', minify: true });
  assert.deepEqual(minified.warnings, [], 'production CSS must parse without dropped declarations or empty selectors');
  assert.match(result.css, /content-visibility:\s*visible/);
  assert.match(result.css, /touch-action:\s*pan-y/);
});
