import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

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

test('a long Markdown document with several code blocks has one total preview', () => {
  const content = Array.from({ length: 8 }, (_, index) => `## Section ${index}\n\n${'Document paragraph. '.repeat(25)}\n\n\`\`\`ts\n${'const value = 1;\n'.repeat(16)}\`\`\`\n`).join('\n');
  const { container } = render(<LongUserMessage content={content} />);
  const toggle = screen.getByRole('button', { name: /Show more|展开内容/ });
  assert.equal(container.querySelectorAll('.max-h-52').length, 1);
  assert.equal(screen.getAllByRole('button', { name: /Show more|展开内容|Show code|展开代码/ }).length, 1);
  fireEvent.click(toggle);
  assert.equal(container.querySelectorAll('.max-h-52').length, 0);
  fireEvent.click(toggle);
  assert.equal(container.querySelectorAll('.max-h-52').length, 1);
});

test('editing long expanded content resets its preview', () => {
  const { rerender } = render(<LongUserMessage content={'Original document. '.repeat(180)} />);
  fireEvent.click(screen.getByRole('button', { name: /Show more|展开内容/ }));
  rerender(<LongUserMessage content={'Replacement document. '.repeat(180)} />);
  assert.equal(screen.getByRole('button', { name: /Show more|展开内容/ }).getAttribute('aria-expanded'), 'false');
});


test('rendered height folds Markdown even below the character and source-line thresholds', () => {
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(650);
  try {
    const { container } = render(<LongUserMessage content="## Heading\n\nA short source that wraps to many lines on a narrow screen." />);
    const toggle = screen.getByRole('button', { name: /Show more|展开内容/ });
    assert.equal(container.querySelectorAll('.max-h-52').length, 1);
    fireEvent.click(toggle);
    assert.equal(container.querySelector('.max-h-52'), null);
  } finally {
    height.mockRestore();
  }
});
