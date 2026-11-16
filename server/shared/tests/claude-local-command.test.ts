import assert from 'node:assert/strict';
import test from 'node:test';

import { extractClaudeTaggedContent, formatClaudeLocalCommand, parseClaudeLocalCommand } from '@/shared/index.js';

for (const [raw, expected] of [
  ['<command-name>/model</command-name><command-message>ignored</command-message><command-args> opus </command-args>', '/model opus'],
  ['<command-message> /help </command-message>', '/help'],
  ['<command-args>orphan arguments</command-args>', ''],
  ['<command-name>/路径</command-name><command-args>第一行\n第二行</command-args>', '/路径 第一行\n第二行'],
]) test(`Claude history/search share command rendering: ${expected || '(hidden)'}`, () => {
  const parsed = parseClaudeLocalCommand(raw);
  assert.ok(parsed);
  assert.equal(formatClaudeLocalCommand(parsed), expected);
});
test('ordinary text is not interpreted as a local command and tag names are literal', () => {
  assert.equal(parseClaudeLocalCommand('ordinary <div>message</div>'), null);
  assert.equal(extractClaudeTaggedContent('<aXb>wrong</aXb><a.b>literal</a.b>', 'a.b'), 'literal');
  assert.equal(extractClaudeTaggedContent('<local-command-stdout>line 1\nline 2</local-command-stdout>', 'local-command-stdout'), 'line 1\nline 2');
});
