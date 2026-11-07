import { useTranslation } from 'react-i18next';

import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  strictFileIsolation?: boolean;
  isolationAvailable?: boolean;
  isolationReason?: string;
  onStrictFileIsolationChange?: (enabled: boolean) => void;
  backendId?: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onAdvanceToConfirm: () => void;
};

/** Rendered by ProjectCreationWizard as the workspace-path step after the target backend is chosen. */
export default function StepConfiguration({
  workspacePath,
  strictFileIsolation = false, isolationAvailable = false, isolationReason, onStrictFileIsolationChange,
  backendId,
  isCreating,
  onWorkspacePathChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.step2.newPath')}
      </label>
      <WorkspacePathField
        value={workspacePath}
        backendId={backendId}
        disabled={isCreating}
        onChange={onWorkspacePathChange}
        onAdvanceToConfirm={onAdvanceToConfirm}
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('projectWizard.step2.newHelp')}</p>
      <label className="mt-5 flex items-start gap-3 rounded-lg border border-border p-3">
        <input type="checkbox" checked={strictFileIsolation} disabled={!isolationAvailable || isCreating} onChange={(event) => onStrictFileIsolationChange?.(event.target.checked)} className="mt-1" />
        <span className="text-sm">
          <span className="font-medium">{t('projectWizard.isolation.label')}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{t('projectWizard.isolation.description')}</span>
          {!isolationAvailable && <span className="mt-1 block text-xs text-muted-foreground" title={isolationReason}>{t('projectWizard.isolation.unavailable')}</span>}
        </span>
      </label>
    </div>
  );
}
