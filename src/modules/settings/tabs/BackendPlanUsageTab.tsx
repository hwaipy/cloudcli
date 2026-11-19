import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { PROVIDER_LABELS } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';
import { CodexPlanUsage } from '@/modules/settings/tabs/agents-settings/sections/content/CodexPlanUsage';
import { ClaudePlanUsage } from '@/modules/settings/tabs/agents-settings/sections/content/ClaudePlanUsage';

type Backend = { id: string; name: string; color?: string; online?: boolean };
type InstalledProvider = { id: LLMProvider; authenticated: boolean; email: string | null };

/** Backend management renders quota for its explicitly selected backend. */
export function BackendQuota({ backend }: { backend: Backend }) {
  const { t } = useTranslation('settings');
  // Each backend discovers its own installed vendors without consulting the active project.
  const [providers, setProviders] = useState<InstalledProvider[] | null>(null);
  // A discovery failure is different from a backend with no installed providers.
  const [error, setError] = useState(false);
  useEffect(() => {
    if (backend.online === false) return;
    let active = true;
    setProviders(null);
    setError(false);
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const results = await Promise.allSettled((Object.keys(PROVIDER_LABELS) as LLMProvider[]).map(async (id) => {
        const payload = await readApiJson<{ data: { installed: boolean; authenticated: boolean; email?: string | null } }>(await api.providers.authStatus(id, backend.id, { signal: AbortSignal.timeout(15_000) }));
        return payload.data.installed ? { id, authenticated: payload.data.authenticated, email: payload.data.email ?? null } : null;
      }));
      if (!active) return;
      setProviders(results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
      setError(results.some(result => result.status === 'rejected'));
      timer = setTimeout(() => void refresh(), 60_000);
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [backend.id, backend.online]);
  return (
    <section aria-label={backend.name} className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-full bg-muted" style={{ backgroundColor: backend.color }} />{backend.name}<span className="text-xs font-normal text-muted-foreground">{backend.online === false ? t('planUsage.offline') : t('planUsage.online')}</span></h3>
      {backend.online === false ? <p className="text-sm text-muted-foreground">{t('planUsage.offlineHint')}</p> : <>
        {providers === null && <p className="text-sm text-muted-foreground">{t('planUsage.loading')}</p>}
        {error && <p role="status" className="text-sm text-muted-foreground">{t('planUsage.discoveryFailed')}</p>}
        {providers?.length === 0 && !error && <p className="text-sm text-muted-foreground">{t('planUsage.noProviders')}</p>}
        {providers?.map(provider => <div key={provider.id} role="group" aria-label={`${backend.name} · ${PROVIDER_LABELS[provider.id]}`} className="space-y-2">
          <h4 className="text-sm font-medium">{PROVIDER_LABELS[provider.id]}</h4>
          {provider.email && <p className="break-all text-xs text-muted-foreground">{provider.email}</p>}
          {!provider.authenticated ? <p className="text-sm text-muted-foreground">{t('planUsage.notAuthenticated')}</p>
            : provider.id === 'codex' ? <CodexPlanUsage key={`${backend.id}:codex:${provider.email ?? ""}`} backendId={backend.id} />
              : provider.id === 'claude' ? <ClaudePlanUsage key={`${backend.id}:claude:${provider.email ?? ""}`} backendId={backend.id} />
                : <p className="text-sm text-muted-foreground">{t('planUsage.unsupported')}</p>}
        </div>)}
      </>}
    </section>
  );
}

/** Settings renders a read-only quota inventory grouped by Hub backend and its installed vendors. */
export default function BackendPlanUsageTab() {
  const { t } = useTranslation('settings');
  // Hub identity is the stable ownership boundary for each quota panel.
  const [backends, setBackends] = useState<Backend[] | null>(null);
  // Inventory errors must not fall back to the default backend.
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const payload = await readApiJson<{ backends: Backend[] }>(await api.hub.backends({ signal: AbortSignal.timeout(15_000) }));
        if (!Array.isArray(payload.backends) || payload.backends.some(backend => typeof backend.id !== 'string' || !backend.id.trim() || typeof backend.name !== 'string')) throw new Error('Invalid backend inventory');
        if (active) { setBackends(payload.backends); setError(false); }
      } catch { if (active) setError(true); }
      finally { if (active) timer = setTimeout(() => void refresh(), 60_000); }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">{t('mainTabs.usage')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('planUsage.description')}</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{t('planUsage.inventoryFailed')}</p>}
    {!backends && !error && <p className="text-sm text-muted-foreground">{t('planUsage.loading')}</p>}
    {backends?.length === 0 && <p className="text-sm text-muted-foreground">{t('planUsage.noBackends')}</p>}
    {backends?.map(backend => <BackendQuota key={backend.id} backend={backend} />)}
  </div>;
}
