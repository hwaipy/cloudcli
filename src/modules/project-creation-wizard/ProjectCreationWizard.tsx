import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepBackendSelection from '@/modules/project-creation-wizard/StepBackendSelection';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import StepReview from '@/modules/project-creation-wizard/StepReview';
import WizardFooter from '@/modules/project-creation-wizard/WizardFooter';
import WizardProgress from '@/modules/project-creation-wizard/WizardProgress';
import { createProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';
import type { WizardStep } from '@/shared/types';
import { api } from '@/shared/api';
import { getHubBackendId } from '@/shared/utils';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

type ProjectBackend = { id: string; name: string; online: boolean };

/** Rendered by the sidebar module's modal layer to create a project on a selected backend. */
export default function ProjectCreationWizard({ onClose, onProjectCreated }: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const injectedBackendId = getHubBackendId();
  const firstStep: WizardStep = 1;
  // The wizard retains only the selected workspace path between its path and review steps.
  const [workspacePath, setWorkspacePath] = useState('');
  // The project is always created on an explicitly selected registered Hub backend.
  const [backends, setBackends] = useState<ProjectBackend[]>([]);
  // Keep the current Hub backend selected by default, then fall back to the first online backend.
  const [backendId, setBackendId] = useState<string | undefined>(injectedBackendId ?? undefined);
  // These states drive loading and validation feedback for the initial backend-selection step.
  const [loadingBackends, setLoadingBackends] = useState(true);
  const [backendLoadError, setBackendLoadError] = useState<string | null>(null);
  // The wizard always starts by selecting the Hub backend before browsing its filesystem.
  const [step, setStep] = useState<WizardStep>(1);
  // Creation state prevents duplicate requests and disables controls while the project is saved.
  const [isCreating, setIsCreating] = useState(false);
  // Error text is shown in the current wizard step without discarding entered values.
  const [error, setError] = useState<string | null>(null);

  // This choice is persisted on the project; changing servers resets it until capabilities are known.
  const [strictFileIsolation, setStrictFileIsolation] = useState(false);
  // Capability results prevent offering strict mode on unsupported or unreachable backends.
  const [isolationCapability, setIsolationCapability] = useState<{ available: boolean; reason?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStrictFileIsolation(false);
    setIsolationCapability(null);
    if (backendId) void api.projectIsolationCapabilities(backendId).then(async (response) => {
      if (!response.ok) throw new Error('Backend isolation capability check failed');
      const capability = await response.json();
      if (!cancelled) setIsolationCapability(capability);
    }).catch(() => {
      if (!cancelled) setIsolationCapability({ available: false });
    });
    return () => { cancelled = true; };
  }, [backendId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingBackends(true);
    void api.hub.backends().then(async (response) => {
      if (!response.ok) throw new Error(`Backend list request failed (${response.status})`);
      const payload = await response.json() as { backends?: Array<{ id?: unknown; name?: unknown; online?: unknown }> };
      const discovered = (payload.backends ?? []).filter((backend): backend is { id: string; name: string; online: boolean } =>
        typeof backend.id === 'string' && typeof backend.name === 'string' && typeof backend.online === 'boolean',
      );
      if (cancelled) return;
      setBackends(discovered);
      setBackendId((current) =>
        discovered.some((backend) => backend.id === current && backend.online)
          ? current
          : discovered.find((backend) => backend.online)?.id,
      );
      if (!discovered.some((backend) => backend.online)) {
        setBackendLoadError(t('projectWizard.errors.noOnlineBackends'));
      }
    }).catch((loadError: unknown) => {
      if (cancelled) return;
      console.error('Could not load Hub servers for project creation:', loadError);
      setBackendLoadError(t('projectWizard.errors.loadBackendsFailed'));
    }).finally(() => {
      if (!cancelled) setLoadingBackends(false);
    });
    return () => { cancelled = true; };
  }, [injectedBackendId, t]);

  const selectedBackendName = backends.find((backend) => backend.id === backendId)?.name;

  const handleNext = useCallback(() => {
    setError(null);
    if (step === 1) {
      if (!backendId || !backends.some((backend) => backend.id === backendId && backend.online)) {
        setError(t('projectWizard.errors.selectBackend'));
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      setStep(3);
    }
  }, [backendId, backends, step, t, workspacePath]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((currentStep) => (currentStep > firstStep ? ((currentStep - 1) as WizardStep) : currentStep));
  }, [firstStep]);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const project = await createProjectRequest({ path: workspacePath.trim(), strictFileIsolation }, backendId);
      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('projectWizard.errors.failedToCreate'));
    } finally {
      setIsCreating(false);
    }
  }, [backendId, onClose, onProjectCreated, strictFileIsolation, t, workspacePath]);

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('projectWizard.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
            aria-label={t('projectWizard.buttons.cancel')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} isHubMode />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}
          {step === 1 && (
            <StepBackendSelection
              backends={backends}
              selectedBackendId={backendId}
              loading={loadingBackends}
              loadError={backendLoadError}
              onSelect={setBackendId}
            />
          )}
          {step === 2 && (
            <StepConfiguration
              workspacePath={workspacePath}
              backendId={backendId}
              strictFileIsolation={strictFileIsolation}
              onStrictFileIsolationChange={setStrictFileIsolation}
              isolationAvailable={isolationCapability?.available === true}
              isolationReason={isolationCapability?.reason}
              isCreating={isCreating}
              onWorkspacePathChange={setWorkspacePath}
              onAdvanceToConfirm={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepReview workspacePath={workspacePath} backendName={selectedBackendName} strictFileIsolation={strictFileIsolation} />
          )}
        </div>

        <WizardFooter
          step={step}
          firstStep={firstStep}
          isCreating={isCreating}
          nextDisabled={step === 1 && (loadingBackends || !backendId || Boolean(backendLoadError))}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
