import { memo, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ProviderModelOption } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';

type ComposerModelMenuProps = {
  model: string;
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

/** Rendered by ChatComposer to choose the active provider's model independently of reasoning effort. */
export const ComposerModelMenu = memo(function ComposerModelMenu({ model, modelOptions, onSelectModel, modelsLoading }: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  // The model menu must close after a selection or an outside click.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);
  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model || t('composer.model', { defaultValue: 'Model' });
  const ariaLabel = t('composer.selectModel', { model: modelLabel, defaultValue: 'Model: {{model}}' });

  if (modelOptions.length === 0 && !modelsLoading) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-28 shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-48"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{modelLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>{t('composer.model', { defaultValue: 'Model' })}</ComposerMenuHeading>
          {modelOptions.length === 0 && modelsLoading && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
              {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
            </p>
          )}
          {modelOptions.map((option) => (
            <ComposerMenuItem
              key={option.value}
              label={option.label || option.value}
              isSelected={option.value === model}
              onSelect={() => {
                onSelectModel(option.value);
                setIsOpen(false);
              }}
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
});
