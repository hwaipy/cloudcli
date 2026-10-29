import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import { ACCOUNT_AVATAR_PRESETS } from '@/shared/constants';
import { AccountAvatar } from '@/shared/ui';

async function prepareAvatarPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('invalidPhoto');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('uploadFailed');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 256, 256);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    const data = canvas.toDataURL('image/jpeg', 0.82);
    if (data.length > 350_000) throw new Error('uploadFailed');
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  // Avatar updates are independent from the password-protected sign-in form.
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState('');

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

  const saveAvatar = async (avatar: string | null) => {
    if (avatarPending) return;
    setAvatarPending(true);
    setAvatarError('');
    try {
      await readApiJson(await api.auth.updateOwnAvatar(avatar));
      await refreshUser();
    } catch (caught) {
      setAvatarError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAvatarPending(false);
    }
  };

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      await saveAvatar(await prepareAvatarPhoto(file));
    } catch (caught) {
      const key = caught instanceof Error && caught.message === 'invalidPhoto' ? 'invalidPhoto' : 'uploadFailed';
      setAvatarError(t(`account.${key}`));
    }
  };

  return <section className="max-w-xl space-y-5">
    <div>
      <h3 className="text-lg font-medium">{t('account.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('account.description')}</p>
    </div>
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="font-medium">{t('account.avatar')}</h4>
      <div className="flex items-center gap-3">
        <AccountAvatar username={user?.username ?? ''} avatar={user?.avatar} className="h-14 w-14 text-2xl" />
        <span className="text-sm text-muted-foreground">{t('account.avatarHint')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {ACCOUNT_AVATAR_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={avatarPending} onClick={() => { void saveAvatar(`preset:${preset.id}`); }} aria-label={`${t('account.avatar')} ${preset.id}`} aria-pressed={user?.avatar === `preset:${preset.id}`} className={`rounded-full p-1 disabled:opacity-50 ${user?.avatar === `preset:${preset.id}` ? 'ring-2 ring-primary' : 'hover:bg-accent'}`}><AccountAvatar username={user?.username ?? ''} avatar={`preset:${preset.id}`} className="h-10 w-10 text-xl" /></button>)}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer rounded-md border border-border px-3 py-2 hover:bg-accent">
          {t('account.uploadPhoto')}
          <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={avatarPending} onChange={(event) => { void uploadPhoto(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        <button type="button" disabled={avatarPending || !user?.avatar} onClick={() => { void saveAvatar(null); }} className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent disabled:opacity-50">{t('account.removeAvatar')}</button>
      </div>
      {avatarError && <p role="alert" className="text-sm text-destructive">{avatarError}</p>}
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
