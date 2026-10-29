import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';

/** Rendered by Settings so every signed-in person can update their own sign-in details. */
export default function AccountSettingsTab() {
  const { t } = useTranslation('settings');
  const { user, refreshUser } = useAuth();
  // The editable name is initialized from the authenticated account and follows account refreshes.
  const [username, setUsername] = useState(user?.username ?? '');
  // Passwords remain only in the form until a save succeeds or this tab unmounts.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  // This flag prevents duplicate credential writes.
  const [pending, setPending] = useState(false);
  // Save feedback is local to the profile form.
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => { setUsername(user?.username ?? ''); }, [user?.username]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await readApiJson(await api.auth.updateOwnAccount(username, currentPassword, newPassword || undefined));
      await refreshUser();
      setCurrentPassword('');
      setNewPassword('');
      setFeedback({ error: false, text: t('account.saved') });
    } catch (caught) {
      setFeedback({ error: true, text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setPending(false);
    }
  };

  return <section className="max-w-xl space-y-5">
    <div>
      <h3 className="text-lg font-medium">{t('account.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('account.description')}</p>
    </div>
    <form onSubmit={(event) => { void save(event); }} className="space-y-3 rounded-lg border border-border p-4">
      <label className="block text-sm">
        <span>{t('account.username')}</span>
        <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" autoComplete="username" minLength={3} required value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label className="block text-sm">
        <span>{t('account.currentPassword')}</span>
        <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
      </label>
      <label className="block text-sm">
        <span>{t('account.newPassword')}</span>
        <input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" type="password" autoComplete="new-password" minLength={6} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </label>
      {feedback && <p role="status" className={feedback.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{feedback.text}</p>}
      <button type="submit" disabled={pending} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{pending ? t('account.saving') : t('account.save')}</button>
    </form>
  </section>;
}
