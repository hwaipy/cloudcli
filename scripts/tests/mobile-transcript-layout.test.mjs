import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import path from 'node:path';

// Isolated browser runtime: npm install --prefix .debug-local/scroll-browser-runtime playwright
// Then install webkit with that runtime's CLI; no production login or messages are used.
const require = createRequire(import.meta.url);
const { webkit } = require(path.resolve(process.env.CLOUDCLI_PLAYWRIGHT_MODULE || '.debug-local/scroll-browser-runtime/node_modules/playwright'));

test('mobile WebKit preserves visible message position while scrolling variable-height transcript rows', { timeout: 60000 }, async () => {
  const css = await readFile(process.env.CLOUDCLI_TRANSCRIPT_CSS || 'src/index.css', 'utf8');
  const transcriptRules = process.env.CLOUDCLI_TRANSCRIPT_CSS ? css : [...css.matchAll(/\.chat-(?:message(?:\.(?:assistant|user|tool|error))?|messages-pane)(?:,\s*\.chat-message\.(?:assistant|user|tool|error))*\s*\{[^}]*\}/g)].map(match => match[0]).join('\n');
  assert.match(transcriptRules, /chat-message/);
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    const messages = Array.from({ length: 90 }, (_, index) => {
      const lines = 5 + (index * 31) % 100;
      return `<article class="chat-message assistant" data-row="${index}"><h3>Message ${index}</h3><pre>${Array.from({ length: lines }, (_, line) => `line ${line}: a realistic tool or Markdown output`).join('\n')}</pre></article>`;
    }).join('');
    await page.setContent(`<style>body{margin:0;font:16px/1.5 sans-serif}#pane{height:650px;overflow:auto;width:390px}.chat-message{padding:12px;box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}h3{margin:0}${transcriptRules}</style><div id="pane" class="chat-messages-pane">${messages}</div>`);
    const result = await page.evaluate(async () => {
      const pane = document.querySelector('#pane');
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await settle(); pane.scrollTop = pane.scrollHeight; await settle();
      const jumps = [];
      for (const direction of [-1, 1, -1]) {
        for (let step = 0; step < 100; step++) {
          pane.scrollTop += direction * 175;
          const anchor = document.elementFromPoint(180, 160)?.closest('[data-row]');
          if (!anchor) { await settle(); continue; }
          const before = anchor.getBoundingClientRect().top;
          const scrollBefore = pane.scrollTop;
          await settle();
          const movement = anchor.getBoundingClientRect().top - before;
          if (Math.abs(movement) > 3) jumps.push({ row: anchor.dataset.row, movement, scrollBefore, scrollAfter: pane.scrollTop });
        }
      }
      return { jumps, height: pane.scrollHeight };
    });
    await mkdir('.debug-local', { recursive: true });
    if (result.jumps.length) await page.screenshot({ path: '.debug-local/mobile-scroll-layout-failure.png' });
    console.log(JSON.stringify(result));
    assert.equal(result.jumps.length, 0, 'visible content moved after a scroll frame without another gesture');
  } finally { await context.close(); await browser.close(); }
});
