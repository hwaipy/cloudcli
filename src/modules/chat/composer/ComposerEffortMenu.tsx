import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerEffortMenuProps = {
  effort: string;
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
};

/** Rendered by ChatComposer as a half-dial showing the selected reasoning effort. */
export const ComposerEffortMenu = memo(function ComposerEffortMenu({ effort, effortOptions, onSelectEffort }: ComposerEffortMenuProps) {
  const { t } = useTranslation('chat');
  // The effort menu must remain independent of the neighboring model menu.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 14 * 16);
  if (effortOptions.length === 0) return null;

  const defaultLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultLabel : effort;
  const ariaLabel = t('composer.selectEffort', {
    effort: effortLabel,
    defaultValue: 'Reasoning effort: {{effort}}',
  });
  const selectedIndex = effortOptions.findIndex((option) => option.value === effort);
  // Low effort points left, high effort points right; default rests at the centre.
  const ratio = selectedIndex < 0 ? 0.5 : effortOptions.length === 1 ? 0.5 : selectedIndex / (effortOptions.length - 1);
  const angle = Math.PI * (1 - ratio);
  const needleX = 12 + 6.5 * Math.cos(angle);
  const needleY = 17 - 6.5 * Math.sin(angle);
  const menuOptions: EffortOption[] = [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-foreground transition-colors hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
          <path d="M3 17a9 9 0 0 1 18 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M5 18h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.45" />
          <path d={`M12 17L${needleX.toFixed(2)} ${needleY.toFixed(2)}`} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" data-effort-needle />
          <circle cx="12" cy="17" r="1.6" fill="currentColor" />
        </svg>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>{t('composer.reasoning', { defaultValue: 'Reasoning' })}</ComposerMenuHeading>
          {menuOptions.map((option) => (
            <ComposerMenuItem
              key={option.value}
              label={option.value === DEFAULT_EFFORT_VALUE ? defaultLabel : option.value}
              description={option.description}
              isSelected={option.value === effort}
              onSelect={() => {
                onSelectEffort(option.value);
                setIsOpen(false);
              }}
              className="capitalize"
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
});
