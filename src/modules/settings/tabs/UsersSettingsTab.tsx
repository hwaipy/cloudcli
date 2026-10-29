import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';

type ManagedUser = { id: number; username: string };

/** Used by Settings to let the first account add sign-in accounts. */
export default function UsersSettingsTab() {
  const { t } = useTranslation('settings');
  // The list is refreshed after creation so the administrator sees the new account immediately.
  const [users, setUsers] = useState<ManagedUser[]>([]);
  // Credentials exist only while the form is being submitted and are never persisted locally.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // A single pending flag prevents duplicate account creation from rapid taps.
  const [pending, setPending] = useState(false);
  // The form reports server-side validation and account-name conflicts inline.
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    void api.auth.users()
      .then((response) => readApiJson<{ users: ManagedUser[] }>(response))
      .then((data) => { if (mounted) setUsers(data.users); })
      .catch((caught) => { if (mounted) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { mounted = false; };
  }, []);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await api.auth.createUser(username, password);
      const result = await readApiJson<{ user: ManagedUser }>(response);
      setUsers((current) => [...current, result.user]);
      setUsername('');
      setPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="max-w-xl space-y-5">
      <div>
        <h3 className="text-lg font-medium">{t('users.title', 'Users')}</h3>
        <p className="text-sm text-muted-foreground">{t('users.description', 'Each account has its own project and session list. CLI credentials and the host filesystem remain shared.')}</p>
      </div>
      <div className="space-y-1 text-sm">
        {users.map((user) => <div key={user.id} className="rounded-md border border-border px-3 py-2">{user.username}</div>)}
      </div>
      <form onSubmit={(event) => { void createUser(event); }} className="space-y-3 rounded-lg border border-border p-4">
        <h4 className="font-medium">{t('users.add', 'Add user')}</h4>
        <label className="block text-sm">
          <span>{t('users.username', 'Username')}</span>
          <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" autoComplete="off" minLength={3} required value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span>{t('users.password', 'Initial password')}</span>
          <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={pending} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {pending ? t('users.creating', 'Creating…') : t('users.create', 'Create account')}
        </button>
      </form>
    </section>
  );
}
