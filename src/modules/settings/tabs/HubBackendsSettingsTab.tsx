import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';

import { api, readApiJson } from '@/shared/api';

type ManagedBackend = {
  id: string;
  name: string;
  color: string;
  online: boolean;
  keyConfigured: boolean;
  registeredAt: number | null;
  lastConnectedAt: number | null;
};

type IssuedBackendKey = { id: string; name: string; key: string };

/** Rendered by Settings for administrators to provision per-backend Hub connection keys. */
export default function HubBackendsSettingsTab() {
  const { t } = useTranslation('settings');
  const paletteOps = usePaletteOps();
  // The Hub's persisted inventory is loaded here so admins can provision both existing and new nodes.
  const [backends, setBackends] = useState<ManagedBackend[]>([]);
  // This loading state distinguishes the first inventory fetch from an empty Hub.
  const [loading, setLoading] = useState(true);
  // One pending flag prevents duplicate key issuance while a request is in flight.
  const [pending, setPending] = useState(false);
  // The form holds only the display name for a new backend; Hub assigns its stable ID.
  const [name, setName] = useState('');
  // API and clipboard errors are shown in the management page instead of disappearing.
  const [error, setError] = useState('');
  // Raw credentials remain in component memory only and are cleared when another key is issued or the tab unmounts.
  const [issuedKey, setIssuedKey] = useState<IssuedBackendKey | null>(null);
  // Copy feedback is attached to the one-time key panel.
  const [copied, setCopied] = useState(false);

  const loadBackends = useCallback(async () => {
    try {
      const response = await api.hub.managedBackends();
      const payload = await readApiJson<{ backends: ManagedBackend[] }>(response);
      setBackends(payload.backends);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadBackends(); }, [loadBackends]);

  const showIssuedKey = (result: { backend: { id: string; name: string }; key: string }) => {
    setIssuedKey({ id: result.backend.id, name: result.backend.name, key: result.key });
    setCopied(false);
    void loadBackends();
  };

  const createBackend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await readApiJson<{ backend: { id: string; name: string }; key: string }>(await api.hub.createBackend(name));
      setName('');
      showIssuedKey(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const issueKeyForExistingBackend = async (backend: ManagedBackend) => {
    if (pending) return;
    if (backend.keyConfigured && !window.confirm(t('backends.rotateWarning'))) return;
    setPending(true);
    setError('');
    try {
      const result = await readApiJson<{ backend: { id: string; name: string }; key: string }>(await api.hub.createBackendKey(backend.id));
      showIssuedKey(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const saveBackend = async (event: FormEvent<HTMLFormElement>, backend: ManagedBackend) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      await readApiJson(await api.hub.updateBackend(backend.id, String(form.get('name')), String(form.get('color'))));
      await loadBackends();
      await paletteOps.refreshProjects();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const copyKey = async () => {
    if (!issuedKey) return;
    try {
      await navigator.clipboard.writeText(issuedKey.key);
      setCopied(true);
    } catch {
      setError(t('backends.copyFailed'));
    }
  };

  const copyBackendEnvironment = async () => {
    if (!issuedKey) return;
    const template = [
      `CLOUDCLI_HUB_URL='${window.location.origin}'`,
      `CLOUDCLI_HUB_REGISTRATION_KEY='${issuedKey.key}'`,
      `CLOUDCLI_BACKEND_ID='${issuedKey.id}'`,
      `CLOUDCLI_BACKEND_NAME='${issuedKey.name.replace(/'/g, "'\\''")}'`,
      "CLOUDCLI_BACKEND_URL='http://<Hub可访问的主机>:3001'",
    ].join('\n');
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
    } catch {
      setError(t('backends.copyFailed'));
    }
  };

  return (
    <section className="max-w-2xl space-y-5">
      <header>
        <h3 className="text-lg font-medium">{t('backends.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('backends.description')}</p>
      </header>

      {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      {issuedKey && (
        <section className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4" aria-live="polite">
          <div>
            <h4 className="font-medium">{t('backends.keyReady', { name: issuedKey.name })}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{t('backends.keyWarning')}</p>
          </div>
          <code className="block break-all rounded-md border border-border bg-background p-3 text-sm">{issuedKey.key}</code>
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" onClick={() => { void copyKey(); }} className="rounded-md bg-primary px-3 py-2 text-primary-foreground">{copied ? t('backends.copied') : t('backends.copyKey')}</button>
            <button type="button" onClick={() => { void copyBackendEnvironment(); }} className="rounded-md border border-border px-3 py-2">{t('backends.copyConfig')}</button>
            <span className="self-center text-muted-foreground">{t('backends.setBackendUrl')}</span>
          </div>
          <code className="block break-all rounded-md bg-background/70 p-2 text-xs">CLOUDCLI_BACKEND_URL='http://&lt;Hub可访问的主机&gt;:3001'</code>
        </section>
      )}

      <form onSubmit={(event) => { void createBackend(event); }} className="space-y-3 rounded-lg border border-border p-4">
        <h4 className="font-medium">{t('backends.addTitle')}</h4>
        <label className="block text-sm">
          <span>{t('backends.nameLabel')}</span>
          <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={pending || !name.trim()} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {pending ? t('backends.working') : t('backends.addButton')}
        </button>
      </form>

      <div className="space-y-2">
        <h4 className="font-medium">{t('backends.existingTitle')}</h4>
        {loading ? <p className="text-sm text-muted-foreground">{t('backends.loading')}</p> : backends.length === 0 ? <p className="text-sm text-muted-foreground">{t('backends.empty')}</p> : backends.map((backend) => (
          <form key={`${backend.id}:${backend.name}:${backend.color}`} onSubmit={(event) => { void saveBackend(event, backend); }} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <span className={`h-2.5 w-2.5 rounded-full ${backend.online ? 'bg-green-500' : 'bg-muted-foreground/50'}`} aria-label={backend.online ? t('backends.online') : t('backends.offline')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <input type="color" name="color" aria-label={t('backends.colorLabel')} defaultValue={backend.color || '#3b82f6'} className="h-8 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                <input name="name" aria-label={t('backends.nameLabel')} defaultValue={backend.name} required maxLength={100} className="min-w-0 w-full rounded-md border border-border bg-background px-2 py-1 font-medium" />
              </div>
              <div className="break-all text-xs text-muted-foreground">{backend.id} · {backend.online ? t('backends.online') : t('backends.offline')}</div>
            </div>
            <button type="submit" disabled={pending} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">{t('backends.save')}</button>
            <button type="button" disabled={pending} onClick={() => { void issueKeyForExistingBackend(backend); }} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">
              {backend.keyConfigured ? t('backends.rotateKey') : t('backends.createKey')}
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}
