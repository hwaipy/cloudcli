import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';

const { openFileInEditor } = vi.hoisted(() => ({ openFileInEditor: vi.fn() }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor, openDirectory: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const path = '/Volumes/Example/Personal/Projects/Sample Application/documents/cv.pdf';
const citation = `:codex-file-citation{path="${path}" purpose="output"}`;

test('renders the reported citation as a filename and opens the full original path', () => {
  const { getByRole, container } = render(<Markdown>{`下载：${citation}。`}</Markdown>);
  const link = getByRole('link', { name: 'cv.pdf' });
  expect(link.getAttribute('title')).toBe(path);
  expect(container.textContent).toBe('下载：cv.pdf。');
  fireEvent.click(link);
  expect(openFileInEditor).toHaveBeenCalledWith(path, null);
});

test('handles multiple files, Chinese paths, Markdown punctuation and reordered attributes', () => {
  const file = '/tmp/中文/report [final](1).pdf';
  const { getAllByRole } = render(<Markdown>{`${citation} 和 :codex-file-citation{purpose="output" path="${file}"}`}</Markdown>);
  const links = getAllByRole('link');
  expect(links).toHaveLength(2);
  fireEvent.click(links[1]);
  expect(openFileInEditor).toHaveBeenCalledWith(file, null);
});

test('leaves inline and fenced code examples literal', () => {
  const { container } = render(<Markdown>{`\`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\``}</Markdown>);
  expect(container.querySelectorAll('a')).toHaveLength(0);
  expect(container.textContent).toContain(citation);
});

test.each([
  ':codex-file-citation{purpose="output"}',
  ':codex-file-citation{path="/tmp/cv.pdf"',
  ':codex-file-citation{path="javascript:alert(1)"}',
  ':codex-file-citation{path="/a.pdf" path="/b.pdf"}',
])('keeps malformed, incomplete or non-file directives literal: %s', (text) => {
  const { container } = render(<Markdown>{text}</Markdown>);
  expect(container.querySelectorAll('a')).toHaveLength(0);
  expect(container.textContent).toBe(text);
});

test('streaming citation becomes clickable once its closing brace arrives', () => {
  const { rerender, queryByRole, getByRole } = render(<StreamingMarkdown content={citation.slice(0, -1)} isStreaming />);
  expect(queryByRole('link')).toBeNull();
  rerender(<StreamingMarkdown content={citation} isStreaming />);
  fireEvent.click(getByRole('link', { name: 'cv.pdf' }));
  expect(openFileInEditor).toHaveBeenCalledWith(path, null);
});

test('does not treat a web URL attribute as a workspace file', () => {
  const { container } = render(<Markdown>{':codex-file-citation{path="https://example.com/file.pdf"}'}</Markdown>);
  expect(container.querySelector('[data-codex-file-path]')).toBeNull();
  expect(openFileInEditor).not.toHaveBeenCalled();
});

test.each(['/tmp/a_1__b/report.pdf', '/tmp/a`b/report.pdf', '/tmp/a"b/report.pdf', 'C:\\Work\\CV.pdf'])(
  'preserves file path characters and escapes: %s', (filePath) => {
    const text = `:codex-file-citation{path=${JSON.stringify(filePath)} purpose="output"}`;
    const { getByRole } = render(<Markdown>{text}</Markdown>);
    fireEvent.click(getByRole('link'));
    expect(openFileInEditor).toHaveBeenCalledWith(filePath, null);
  },
);
