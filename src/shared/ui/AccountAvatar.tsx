import { ACCOUNT_AVATAR_PRESETS } from '@/shared/constants';
import { cn } from '@/shared/utils';

type AccountAvatarProps = {
  username: string;
  avatar?: string | null;
  className?: string;
};

/** Used by account settings and chat to show a photo, a built-in avatar, or the username initial. */
export function AccountAvatar({ username, avatar, className }: AccountAvatarProps) {
  const preset = ACCOUNT_AVATAR_PRESETS.find((entry) => avatar === `preset:${entry.id}`);
  const initial = Array.from(username.trim())[0]?.toLocaleUpperCase() || '?';
  const baseClassName = cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full', className);

  if (avatar?.startsWith('data:image/')) {
    return <img src={avatar} alt={username} className={cn(baseClassName, 'object-cover')} />;
  }
  if (preset) {
    return <span role="img" aria-label={username} className={cn(baseClassName, preset.className)}>{preset.emoji}</span>;
  }
  return <span role="img" aria-label={username} className={cn(baseClassName, 'bg-primary text-primary-foreground font-medium')}>{initial}</span>;
}
