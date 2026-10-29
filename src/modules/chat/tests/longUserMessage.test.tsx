import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { LongUserMessage } from '@/modules/chat/transcript/LongUserMessage';

const longCode = `Before the code.\n\n\`\`\`ts\n${Array.from({ length: 20 }, (_, index) => `const line${index} = ${index};`).join('\n')}\n\`\`\`\n\nAfter the code.`;

test('only a long fenced code block starts collapsed; surrounding text stays visible', () => {
  const { container } = render(<LongUserMessage content={longCode} />);

  assert.ok(screen.getByText('Before the code.'));
  assert.ok(screen.getByText('After the code.'));
  const toggle = screen.getByRole('button', { name: /Show code|展开代码/ });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelectorAll('.max-h-52').length, 1);

  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelectorAll('.max-h-52').length, 0);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('a long Markdown list collapses while short user text stays open', () => {
  const longMarkdown = Array.from({ length: 30 }, (_, index) => `- Requirement ${index + 1}`).join('\n');
  const { rerender } = render(<LongUserMessage content={longMarkdown} />);
  assert.ok(screen.getByRole('button', { name: /Show more|展开内容/ }));

  rerender(<LongUserMessage content="Please check this short note." />);
  assert.equal(screen.queryByRole('button', { name: /Show more|展开内容/ }), null);
});

test('transcript export renders every long block expanded without controls', () => {
  const { container } = render(
    <TranscriptRenderContext.Provider value={{ isExporting: true }}>
      <LongUserMessage content={longCode} />
    </TranscriptRenderContext.Provider>,
  );
  assert.equal(container.querySelector('.max-h-52'), null);
  assert.equal(screen.queryByRole('button', { name: /Show code|展开代码/ }), null);
});
