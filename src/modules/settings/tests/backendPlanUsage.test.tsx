import assert from 'node:assert/strict';

import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import BackendPlanUsageTab from '@/modules/settings/tabs/BackendPlanUsageTab';

const auth = vi.fn(); const codex = vi.fn(); const claude = vi.fn(); const inventory = vi.fn();
vi.mock('@/shared/api', async (original) => ({
  ...await original<Record<string, unknown>>(),
  api: { hub: { backends: () => inventory() }, providers: {
    authStatus: (...args: unknown[]) => auth(...args), codexPlanUsage: (id?: string) => codex(id), claudePlanUsage: (id?: string) => claude(id),
  } },
}));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const codexUsage = (percent: number) => ({ data: { buckets: [{ limitId: 'codex', limitName: 'Codex', planType: 'plus', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: null }, secondary: null }], resetCreditsAvailable: null, fetchedAt: '2026-11-18T01:00:00Z' } });
function setup() {
  inventory.mockImplementation(() => json({ backends: [{ id: 'office', name: 'MacClaw', online: true }, { id: 'ubuntu', name: 'Ubuntu', online: true }, { id: 'offline', name: 'Offline Lab', online: false }] }));
  auth.mockImplementation((id: string, backend: string) => json({ data: { installed: id === 'codex' || (backend === 'office' && ['claude','cursor'].includes(id)), authenticated: true, email: `${backend}@example.com` } }));
  codex.mockImplementation((backend: string) => json(codexUsage(backend === 'office' ? 11 : 63)));
  claude.mockImplementation(() => json({ data: { planType: 'max', rateLimitTier: 'max_5x', windows: [{ key:'five_hour',label:'5 hours',usedPercent:7,resetsAt:null }], fetchedAt:'2026-11-18T01:00:00Z' } }));
}
afterEach(() => { auth.mockReset(); codex.mockReset(); claude.mockReset(); inventory.mockReset(); });

test('usage is grouped by backend with different vendors and independent quota for the same vendor', async () => {
  setup(); render(<BackendPlanUsageTab />);
  const mac = await screen.findByRole('region',{name:'MacClaw'});
  const ubuntu = screen.getByRole('region',{name:'Ubuntu'});
  await waitFor(() => assert.ok(within(mac).getByText('11%')));
  await waitFor(() => assert.ok(within(ubuntu).getByText('63%')));
  assert.ok(within(mac).getByText('7%'));
  assert.equal(within(ubuntu).queryByText('Claude'), null);
  assert.equal(within(ubuntu).queryByText('11%'), null);
  assert.ok(within(mac).getByText('This provider does not expose subscription usage.'));
  assert.deepEqual(codex.mock.calls.map(([id]) => id).sort(), ['office','ubuntu']);
  assert.deepEqual(claude.mock.calls.map(([id]) => id), ['office']);
  assert.equal(auth.mock.calls.some(([,id]) => id === 'offline'), false);
  assert.ok(screen.getByText('This backend is offline; quota cannot be queried.'));
});

test('a failed quota stays unavailable under its own backend and cannot borrow another backend snapshot', async () => {
  setup(); codex.mockImplementation((backend: string) => backend === 'ubuntu' ? Promise.reject(Error('quota unavailable')) : json(codexUsage(11)));
  render(<BackendPlanUsageTab />);
  const mac = await screen.findByRole('region',{name:'MacClaw'}); const ubuntu = screen.getByRole('region',{name:'Ubuntu'});
  await waitFor(() => assert.ok(within(mac).getByText('11%')));
  await waitFor(() => assert.ok(within(ubuntu).getByText('Usage unavailable')));
  assert.equal(within(ubuntu).queryByText('11%'), null);
  assert.equal(within(ubuntu).queryByText('0%'), null);
});

test('provider discovery failure is not reported as an empty supported-vendor list', async () => {
  setup(); auth.mockRejectedValue(Error('backend down')); render(<BackendPlanUsageTab />);
  await waitFor(() => assert.equal(screen.getAllByText('Some provider accounts could not be checked.').length,2));
  assert.equal(codex.mock.calls.length,0); assert.equal(claude.mock.calls.length,0);
});
