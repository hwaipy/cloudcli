import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ClaudePlanUsage } from '@/modules/settings/tabs/agents-settings/sections/content/ClaudePlanUsage';

const request = vi.fn();
vi.mock('@/shared/api', async (original) => ({
  ...await original<Record<string, unknown>>(),
  api: { providers: { claudePlanUsage: () => request() } },
}));
const snapshot = { planType: 'max', rateLimitTier: 'default_claude_max_5x', fetchedAt: '2026-11-18T01:00:00Z', extraUsageEnabled: false,
  windows: [{ key: 'five_hour', label: '5 hours', usedPercent: 0, resetsAt: null }, { key: 'seven_day', label: '7 days', usedPercent: 37, resetsAt: '2026-11-21T02:00:00Z' }],
};
const response = () => new Response(JSON.stringify({ success: true, data: snapshot }));
afterEach(() => { request.mockReset(); vi.useRealTimers(); });

test('Claude quota shows the official plan and separate five-hour and weekly windows, including zero', async () => {
  request.mockResolvedValue(response());
  render(<ClaudePlanUsage backendId="office" />);
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(2));
  expect(screen.getByText(/Max 5×/)).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '5 hours' }).getAttribute('aria-valuenow')).toBe('0');
  expect(screen.getByRole('progressbar', { name: '7 days' }).getAttribute('aria-valuenow')).toBe('37');
});

test('unavailable Claude quota is not presented as zero usage', async () => {
  request.mockRejectedValue(new Error('login required'));
  render(<ClaudePlanUsage backendId="office" />);
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('Claude quota refreshes once per minute and keeps the last snapshot after a failed refresh', async () => {
  vi.useFakeTimers();
  request.mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline'));
  const view = render(<ClaudePlanUsage backendId="office" />);
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  view.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(2);
});
