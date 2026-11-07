import { useTranslation } from 'react-i18next';

type ProjectBackend = { id: string; name: string; online: boolean };

type StepBackendSelectionProps = {
  backends: ProjectBackend[];
  selectedBackendId?: string;
  loading: boolean;
  loadError: string | null;
  onSelect: (backendId: string) => void;
};

/** Used by ProjectCreationWizard to choose which registered Hub backend will own the new project. */
export default function StepBackendSelection({
  backends,
  selectedBackendId,
  loading,
  loadError,
  onSelect,
}: StepBackendSelectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-gray-900 dark:text-white">{t('projectWizard.backend.title')}</h4>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('projectWizard.backend.description')}</p>
      </div>
      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">{t('projectWizard.backend.loading')}</p>}
      {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
      {!loading && backends.map((backend) => (
        <label
          key={backend.id}
          className={`flex cursor-pointer items-center justify-between rounded-lg border p-4 ${
            backend.online
              ? selectedBackendId === backend.id
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              : 'cursor-not-allowed border-gray-200 opacity-50 dark:border-gray-700'
          }`}
        >
          <span className="flex items-center gap-3">
            <input
              type="radio"
              name="project-backend"
              value={backend.id}
              checked={selectedBackendId === backend.id}
              disabled={!backend.online}
              onChange={() => onSelect(backend.id)}
              className="h-4 w-4 accent-blue-600"
            />
            <span className="font-medium text-gray-900 dark:text-white">{backend.name}</span>
          </span>
          <span className={`text-xs ${backend.online ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
            {backend.online ? t('projectWizard.backend.online') : t('projectWizard.backend.offline')}
          </span>
        </label>
      ))}
    </div>
  );
}
