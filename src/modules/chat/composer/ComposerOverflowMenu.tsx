import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { PermissionMode, ProviderModelOption } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];
type Submenu = 'model' | 'effort' | 'permission' | null;

type ComposerOverflowMenuProps = {
  collapseCount: number;
  usage: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  model: string;
  modelOptions: ProviderModelOption[];
  modelsLoading: boolean;
  onSelectModel: (model: string) => void;
  effort: string;
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  permissionMode: PermissionMode;
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
};

/** Used by ChatComposer when its footer cannot fit all five secondary controls. */
export function ComposerOverflowMenu({
  collapseCount,
  usage,
  onShowTokenUsage,
  model,
  modelOptions,
  modelsLoading,
  onSelectModel,
  effort,
  effortOptions,
  onSelectEffort,
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
}: ComposerOverflowMenuProps) {
  const { t } = useTranslation('chat');
  // The popover is independent of the model, effort and permission popovers.
  const [isOpen, setIsOpen] = useState(false);
  // A subview keeps long option lists inside the same narrow popover.
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const close = useCallback(() => { setIsOpen(false); setSubmenu(null); }, []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);
  const menuLabel = t('composer.moreOptions', { defaultValue: 'More options' });
  const totalLabel = t('usage.sessionTotal', { defaultValue: 'Session total' });
  const contextLabel = t('usage.context', { defaultValue: 'Context' });
  const effortLabel = t('composer.reasoning', { defaultValue: 'Reasoning' });
  const modelLabel = t('composer.model', { defaultValue: 'Model' });
  const permissionLabel = t('composer.permission', { defaultValue: 'Permissions' });
  const choose = (action: () => void) => { action(); close(); };

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={menuLabel}
        title={menuLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => { updateAnchor(); setIsOpen((open) => !open); setSubmenu(null); }}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-foreground hover:bg-muted"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={menuLabel}>
          {submenu ? (
            <>
              <button type="button" onClick={() => setSubmenu(null)} className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-accent">
                <ChevronLeft className="h-4 w-4" />
                {submenu === 'model' ? modelLabel : submenu === 'effort' ? effortLabel : permissionLabel}
              </button>
              {submenu === 'model' && (modelOptions.length > 0 ? modelOptions.map((option) => (
                <ComposerMenuItem key={option.value} label={option.label || option.value} isSelected={option.value === model} onSelect={() => choose(() => onSelectModel(option.value))} />
              )) : modelsLoading ? <ComposerMenuHeading>{t('composer.loadingModels', { defaultValue: 'Loading models…' })}</ComposerMenuHeading> : null)}
              {submenu === 'effort' && ([{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] as EffortOption[]).map((option) => (
                <ComposerMenuItem key={option.value} label={option.value === DEFAULT_EFFORT_VALUE ? t('composer.effortDefault', { defaultValue: 'Default' }) : option.value} description={option.description} isSelected={option.value === effort} onSelect={() => choose(() => onSelectEffort(option.value))} />
              ))}
              {submenu === 'permission' && permissionModes.map((mode) => (
                <ComposerMenuItem key={mode} label={t(`codex.modes.${mode}`, { defaultValue: mode })} isSelected={mode === permissionMode} onSelect={() => choose(() => onSelectPermissionMode(mode))} />
              ))}
            </>
          ) : (
            <>
              <ComposerMenuHeading>{menuLabel}</ComposerMenuHeading>
              {collapseCount >= 1 && <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1">
                <span className="text-sm">{totalLabel}</span>
                <TokenUsageSummary part="total" usage={usage} onClick={() => choose(onShowTokenUsage)} />
              </div>}
              {collapseCount >= 2 && <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1">
                <span className="text-sm">{contextLabel}</span>
                <TokenUsageSummary part="context" usage={usage} onClick={() => choose(onShowTokenUsage)} />
              </div>}
              {collapseCount >= 3 && effortOptions.length > 0 && <ComposerMenuItem label={`${effortLabel}: ${effort === DEFAULT_EFFORT_VALUE ? t('composer.effortDefault', { defaultValue: 'Default' }) : effort}`} role="menuitem" isSelected={false} trailing={<ChevronRight className="h-4 w-4" />} onSelect={() => setSubmenu('effort')} />}
              {collapseCount >= 4 && (modelOptions.length > 0 || modelsLoading) && <ComposerMenuItem label={`${modelLabel}: ${modelOptions.find((option) => option.value === model)?.label || model}`} role="menuitem" isSelected={false} trailing={<ChevronRight className="h-4 w-4" />} onSelect={() => setSubmenu('model')} />}
              {collapseCount >= 5 && permissionModes.length > 0 && <ComposerMenuItem label={`${permissionLabel}: ${t(`codex.modes.${permissionMode}`, { defaultValue: permissionMode })}`} role="menuitem" isSelected={false} trailing={<ChevronRight className="h-4 w-4" />} onSelect={() => setSubmenu('permission')} />}
            </>
          )}
        </ComposerMenuSurface>, document.body,
      )}
    </div>
  );
}
