import { useCallback, useEffect } from 'react';

import { useDesktopNotifications } from '@/modules/desktop-notifications';
import { registerHubResourceBackend } from '@/shared/utils';
import { useProjectActiveSessionState, useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { DesktopNotificationTarget } from '@/shared/types';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { LLMProvider, ProjectWorkspaceShellProps } from '@/shared/types';

/** Headless controller rendered by ProjectWorkspaceShell to register palette operations and handle service-worker navigation messages. */
export default function ProjectEffects({
  navigate,
}: Pick<ProjectWorkspaceShellProps, 'navigate'>) {
  const {
    openSettings,
    refreshProjectsSilently,
    setActiveTab,
    setSidebarOpen,
  } = useProjectEffectsState();

  const { activeSessionId } = useProjectActiveSessionState();
  const { selectedProject, activeTab } = useProjectMainState();
  const navigateNotification = useCallback((target: DesktopNotificationTarget) => {
    if (target.backendId) registerHubResourceBackend('session', target.sessionId, target.backendId);
    if (target.provider) writeSelectedProvider(target.provider as LLMProvider);
    setActiveTab('chat'); setSidebarOpen(false); void refreshProjectsSilently();
    navigate(`/session/${encodeURIComponent(target.sessionId)}`);
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);
  useDesktopNotifications(activeTab === 'chat' ? activeSessionId : null, navigateNotification, selectedProject?.__hubBackendId);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.backendId === 'string' && typeof message.sessionId === 'string') registerHubResourceBackend('session', message.sessionId, message.backendId);

      if (typeof message.provider === 'string' && message.provider.trim()) {
        writeSelectedProvider(message.provider as LLMProvider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  return null;
}
