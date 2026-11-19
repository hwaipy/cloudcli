import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import HubBackendsSettingsTab from '@/modules/settings/tabs/HubBackendsSettingsTab';

const rows = [{ id: 'office', name:'MacClaw', color:'#00aa99', online:true }, { id:'ubuntu',name:'Ubuntu',color:'#ffaa00',online:true }];
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ refreshProjects: async () => {} }) }));
vi.mock('@/shared/api', async (original) => ({ ...await original<Record<string,unknown>>(), api: { hub: {
  managedBackends: async () => new Response(JSON.stringify({backends:rows})),
  backends: async () => new Response(JSON.stringify({backends:rows})),
} } }));
afterEach(() => vi.restoreAllMocks());

test('one top-level tab per backend with add last and only selected settings mounted', async () => {
  render(<HubBackendsSettingsTab renderSettings={backend => <p>settings:{backend.id}</p>} />);
  const mac = await screen.findByRole('tab',{name:/MacClaw/});
  assert.ok(screen.getByText('settings:office'));
  assert.equal(screen.queryByText('settings:ubuntu'),null);
  const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
  assert.equal(tabs.length,3);
  fireEvent.click(screen.getByRole('tab',{name:/Ubuntu/}));
  assert.equal(mac.getAttribute('aria-selected'),'false');
  assert.ok(screen.getByText('settings:ubuntu'));
  assert.equal(screen.queryByText('settings:office'),null);
  fireEvent.click(tabs[2]);
  assert.equal(screen.queryByRole('tabpanel'),null);
  assert.ok(screen.getByRole('textbox'));
});

test('read-only users can inspect backend settings without provisioning controls', async () => {
  render(<HubBackendsSettingsTab canManage={false} renderSettings={backend => <p>settings:{backend.id}</p>} />);
  await screen.findByRole('tab',{name:/MacClaw/});
  assert.equal(within(screen.getByRole('tablist')).getAllByRole('tab').length,2);
  assert.equal(screen.queryByRole('textbox'),null);
});
