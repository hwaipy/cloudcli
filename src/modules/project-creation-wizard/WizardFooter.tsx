import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { WizardStep } from '@/shared/types';

type WizardFooterProps = {
  step: WizardStep;
  firstStep: WizardStep;
  isCreating: boolean;
  nextDisabled: boolean;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
};

/** Rendered by ProjectCreationWizard to provide its cancel, back, next and create actions. */
export default function WizardFooter({
  step,
  firstStep,
  isCreating,
  nextDisabled,
  onClose,
  onBack,
  onNext,
  onCreate,
}: WizardFooterProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between border-t border-gray-200 p-6 dark:border-gray-700">
      <Button variant="outline" onClick={step === firstStep ? onClose : onBack} disabled={isCreating}>
        {step === firstStep ? (
          t('projectWizard.buttons.cancel')
        ) : (
          <>
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t('projectWizard.buttons.back')}
          </>
        )}
      </Button>

      <Button onClick={step === 3 ? onCreate : onNext} disabled={isCreating || nextDisabled}>
        {isCreating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('projectWizard.buttons.creating')}
          </>
        ) : step === 3 ? (
          <>
            <Check className="mr-1 h-4 w-4" />
            {t('projectWizard.buttons.createProject')}
          </>
        ) : (
          <>
            {t('projectWizard.buttons.next')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
