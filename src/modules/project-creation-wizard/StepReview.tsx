import { useTranslation } from 'react-i18next';

type StepReviewProps = {
  workspacePath: string;
  strictFileIsolation?: boolean;
  backendName?: string;
};

/** Used by ProjectCreationWizard to confirm the selected backend and workspace path before creation. */
export default function StepReview({ workspacePath, backendName, strictFileIsolation }: StepReviewProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
      <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
        {t('projectWizard.step3.reviewConfig')}
      </h4>
      <div className="space-y-3">
        {strictFileIsolation && <p className="text-sm font-medium">🔒 {t('projectWizard.isolation.label')}</p>}
        {strictFileIsolation && <p className="text-xs text-muted-foreground">{t('projectWizard.isolation.preparing')}</p>}
        {backendName && (
          <div className="flex justify-between gap-4 text-sm">
            <span className="shrink-0 text-gray-600 dark:text-gray-400">{t('projectWizard.backend.title')}</span>
            <span className="break-all text-right text-gray-900 dark:text-white">{backendName}</span>
          </div>
        )}
        <div className="flex justify-between gap-4 text-sm">
          <span className="shrink-0 text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
          <span className="break-all text-right font-mono text-xs text-gray-900 dark:text-white">{workspacePath}</span>
        </div>
      </div>
    </div>
  );
}
