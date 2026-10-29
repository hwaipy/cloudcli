import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import '@/modules/i18n';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

test('shows cumulative tokens and a separate context ring with hover-only details', async () => {
  const onClick = vi.fn();
  render(<TokenUsageSummary usage={{ used: 40_695, total: 258_400, sessionTotalTokens: 24_015_148 }} onClick={onClick} />);
  const [contextButton, totalButton] = screen.getAllByRole('button');
  expect(totalButton.textContent).toBe('24.015M');
  expect(totalButton.getAttribute('aria-label')).toContain('24,015,148');
  expect(contextButton.textContent).toBe('');
  expect(contextButton.querySelectorAll('circle')).toHaveLength(2);
  expect(contextButton.getAttribute('aria-label')).toContain('40.7K / 258.4K · 16%');
  expect(screen.queryByText(/40.7K \/ 258.4K/)).toBeNull();

  fireEvent.mouseEnter(contextButton.parentElement!);
  expect((await screen.findByText(/40.7K \/ 258.4K/)).textContent).toContain('16%');
  fireEvent.click(totalButton);
  fireEvent.click(contextButton);
  expect(onClick).toHaveBeenCalledTimes(2);
});

test('an unknown context window is not presented as a guessed number', () => {
  render(<TokenUsageSummary usage={{ used: 40_695, sessionTotalTokens: 90_000 }} />);
  const contextButton = screen.getByRole('button', { name: /Context|上下文/ });
  expect(contextButton.textContent).toBe('');
  expect(contextButton.getAttribute('aria-label')).toContain('40.7K / —');
  expect(contextButton.querySelectorAll('circle')).toHaveLength(1);
});

test('cumulative-only providers do not show billed tokens as context occupancy', () => {
  render(<TokenUsageSummary usage={{ used: 42_000, contextUsed: null, sessionTotalTokens: 42_000 }} />);
  const [contextButton, totalButton] = screen.getAllByRole('button');
  expect(totalButton.textContent).toBe('42.0K');
  expect(contextButton.textContent).toBe('');
  expect(contextButton.getAttribute('aria-label')).toContain('— / —');
});
