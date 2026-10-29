import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import { CodexPlanUsage } from '@/modules/settings/tabs/agents-settings/sections/content/CodexPlanUsage';

afterEach(() => vi.restoreAllMocks());

test('shows Codex plan usage inline in settings with window and reset details', async () => {
  vi.spyOn(api.providers, 'codexPlanUsage').mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: {
      buckets: [{
        limitId: 'codex', limitName: null, planType: 'prolite',
        primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1793774154 },
        secondary: null, rateLimitReachedType: null,
      }],
      resetCreditsAvailable: 2,
      fetchedAt: '2026-10-29T00:00:00.000Z',
    },
  }), { status: 200 }));

  render(<CodexPlanUsage />);
  const section = await screen.findByRole('region', { name: /Plan usage|套餐用量/ });
  await waitFor(() => expect(section.textContent).toContain('24%'));
  expect(section.textContent).toContain('prolite');
  expect(section.textContent).toContain('7');
  expect(section.textContent).toContain('2');
  expect(screen.queryByRole('button', { name: /Plan usage|套餐用量/ })).toBeNull();
});

test('shows a clear unavailable state when the quota request fails', async () => {
  vi.spyOn(api.providers, 'codexPlanUsage').mockRejectedValue(new Error('offline'));
  render(<CodexPlanUsage />);
  await waitFor(() => expect(screen.getByRole('region', { name: /Plan usage|套餐用量/ }).textContent).toMatch(/Usage unavailable|暂时无法获取套餐用量/));
});

test('the Codex account settings include plan usage', async () => {
  vi.spyOn(api.providers, 'codexPlanUsage').mockRejectedValue(new Error('offline'));
  vi.spyOn(api.providers, 'cliStatus').mockImplementation(() => new Promise<Response>(() => {}));
  render(<AccountContent agent="codex" authStatus={{ authenticated: true, email: 'user@example.com', method: 'credentials_file', error: null, loading: false }} onLogin={() => {}} />);
  expect(await screen.findByRole('region', { name: /Plan usage|套餐用量/ })).toBeTruthy();
});
