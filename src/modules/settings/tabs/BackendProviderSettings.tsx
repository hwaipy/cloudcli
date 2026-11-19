import { useEffect, useRef, useState } from 'react';

import { useBackendApi } from '@/shared/context/BackendApiContext';
import { hydrateUserPreferences } from '@/shared/userSettings';
import { readApiJson } from '@/shared/api';
import type { AgentSettingsProject, ClaudePermissionsState, CodexPermissionMode, CursorPermissionsState } from '@/shared/types';
import { useProviderAuthStatus, ProviderLoginModal } from '@/modules/provider-auth';
import type { AgentProvider } from '@/shared/types';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';

/** One backend's provider configuration, mounted independently when its management tab is selected. */
export default function BackendProviderSettings() {
  // Project-scoped editors only receive projects owned by this backend.
  const [projects, setProjects] = useState<AgentSettingsProject[]>([]);
  const { api, backendId } = useBackendApi();
  const { providerAuthStatus, refreshProviderAuthStatuses } = useProviderAuthStatus();
  // Preferences belong to the chosen backend; writes never hydrate or overwrite the global mirror.
  const [preferences, setPreferences] = useState<Record<string, unknown> | null>(null);
  // A load failure blocks editing rather than writing defaults over another server's settings.
  const [error, setError] = useState(false);
  // Login state is local to this backend pane and cannot survive a backend tab switch.
  const [login, setLogin] = useState<AgentProvider | null>(null);
  useEffect(() => {
    let active = true;
    void refreshProviderAuthStatuses();
    void (async () => {
      try {
        const payload = await readApiJson<{ preferences: Record<string, unknown> }>(await api.user.preferences());
        if(active) {
          const ui = (payload.preferences?.uiPreferences ?? {}) as Record<string, unknown>;
          const byBackend = (ui.backendProviderSettings ?? {}) as Record<string, Record<string, unknown>>;
          setPreferences(byBackend[backendId ?? ''] ?? {});
        }
        const rows = await readApiJson<Array<{ projectId: string; displayName?: string; path?: string; fullPath?: string }>>(await api.projects());
        if(active) setProjects(rows.map(row => ({ ...row, name: row.projectId })));
      } catch { if(active) setError(true); }
    })();
    return () => { active = false; };
  }, [api, refreshProviderAuthStatuses]);
  // Serialize preference merges so rapid edits do not overwrite earlier saves.
  const writes = useRef(Promise.resolve());
  const persist = async (key: string, value: unknown) => {
    try {
      const latest = await readApiJson<{ preferences: Record<string, unknown> }>(await api.user.preferences());
      const ui = (latest.preferences?.uiPreferences ?? {}) as Record<string, unknown>;
      const byBackend = (ui.backendProviderSettings ?? {}) as Record<string, Record<string, unknown>>;
      await readApiJson(await api.user.savePreferences({ uiPreferences: { ...ui, backendProviderSettings: { ...byBackend, [backendId ?? '']: { ...byBackend[backendId ?? ''], [key]: value } } } }));
      await hydrateUserPreferences();
      setPreferences(previous => ({ ...previous, [key]: value }));
      setError(false);
    } catch { setError(true); }
  };
  const save = (key: string, value: unknown) => {
    writes.current = writes.current.then(() => persist(key, value));
    return writes.current;
  };
  if (!preferences) return <p className="text-sm text-muted-foreground">{error ? '无法读取此后端的配置，请重新打开标签页重试。' : '正在读取后端配置…'}</p>;
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-destructive">保存失败，请重试。</p>}
    <AgentsSettingsTab providerAuthStatus={providerAuthStatus} onProviderLogin={setLogin}
      claudePermissions={(preferences.claudePermissions ?? { allowedTools: [], disallowedTools: [], skipPermissions: false }) as ClaudePermissionsState}
      onClaudePermissionsChange={value => { void save('claudePermissions', value); }}
      cursorPermissions={(preferences.cursorPermissions ?? { allowedCommands: [], disallowedCommands: [], skipPermissions: false }) as CursorPermissionsState}
      onCursorPermissionsChange={value => { void save('cursorPermissions', value); }}
      codexPermissionMode={((preferences.codexPermissions as { permissionMode?: string })?.permissionMode ?? 'default') as CodexPermissionMode}
      onCodexPermissionModeChange={value => { void save('codexPermissions', { permissionMode: value }); }} projects={projects} />
    <ProviderLoginModal isOpen={Boolean(login)} provider={login ?? 'claude'} backendId={backendId} onClose={() => setLogin(null)} onComplete={() => { void refreshProviderAuthStatuses(); }} />
  </div>;
}
