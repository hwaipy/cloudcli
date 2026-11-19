import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { BackendApiProvider } from '@/shared/context/BackendApiContext';
import BackendProviderSettings from '@/modules/settings/tabs/BackendProviderSettings';
import { resetUserPreferences } from '@/shared/userSettings';

const refresh = vi.fn(async () => {});
vi.mock('@/modules/provider-auth', () => ({ useProviderAuthStatus: () => ({ providerAuthStatus: {}, refreshProviderAuthStatuses: refresh }), ProviderLoginModal: () => null }));
vi.mock('@/modules/settings/tabs/agents-settings/AgentsSettingsTab', () => ({ default: (props: { codexPermissionMode: string; onCodexPermissionModeChange: (value: string) => void; projects: Array<{name:string}> }) => <div><p>mode:{props.codexPermissionMode}</p><p>projects:{props.projects.map(p=>p.name).join(',')}</p><button onClick={()=>props.onCodexPermissionModeChange('bypassPermissions')}>save mode</button></div> }));
afterEach(() => { vi.unstubAllGlobals(); resetUserPreferences(); localStorage.clear(); delete (window as Window & {__CLOUDCLI_BACKEND_ID__?:string}).__CLOUDCLI_BACKEND_ID__; });

test('backend editors persist independent permission defaults and load only the selected host projects', async () => {
  (window as Window & {__CLOUDCLI_BACKEND_ID__?:string}).__CLOUDCLI_BACKEND_ID__='office';
  let preferences = { uiPreferences: { backendProviderSettings: { office: { codexPermissions: {permissionMode:'acceptEdits'} }, ubuntu: {codexPermissions:{permissionMode:'default'}} } } };
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if(url.includes('/preferences')) {
      if(options?.method==='PATCH') preferences={...preferences,...JSON.parse(String(options.body))};
      return new Response(JSON.stringify({success:true,preferences}));
    }
    const backend=(options?.headers as Record<string,string>)?.['X-CloudCLI-Backend'];
    return new Response(JSON.stringify([{projectId:`${backend}-project`,path:'/repo'}]));
  });
  vi.stubGlobal('fetch',fetchMock);
  const view=render(<BackendApiProvider backendId="office"><BackendProviderSettings /></BackendApiProvider>);
  await screen.findByText('mode:acceptEdits');
  await screen.findByText('projects:office-project');
  fireEvent.click(screen.getByRole('button',{name:'save mode'}));
  await waitFor(()=>assert.equal(preferences.uiPreferences.backendProviderSettings.office.codexPermissions.permissionMode,'bypassPermissions'));
  assert.equal(preferences.uiPreferences.backendProviderSettings.ubuntu.codexPermissions.permissionMode,'default');
  view.unmount();
  render(<BackendApiProvider backendId="ubuntu"><BackendProviderSettings /></BackendApiProvider>);
  await screen.findByText('mode:default');
  await screen.findByText('projects:ubuntu-project');
});
