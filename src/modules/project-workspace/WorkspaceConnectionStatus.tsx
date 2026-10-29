import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '@/shared/context/WebSocketContext';

/**
 * Rendered by WorkspaceHeader so that a lost chat connection is visible on
 * every tab: while the socket is down nothing typed into the chat can reach the
 * server. Shows nothing while connected or during the first handshake.
 */
export default function WorkspaceConnectionStatus() {
  const { t } = useTranslation();
  const { connectionStatus } = useWebSocket();
  const isDisconnected = connectionStatus === 'disconnected';
  // Names the chat connection, since the Shell tab shows its own socket's state.
  const description = t('status.chatConnectionLost');

  return (
    <>
      {/* Always mounted so screen readers announce the text when it appears (a
          region inserted together with its text is not reliably announced).
          Visually hidden and absolutely positioned, so while connected it takes
          no room and no flex gap from the title. */}
      <div role="status" aria-live="polite" className="sr-only">
        {isDisconnected ? description : null}
      </div>
      {isDisconnected && (
        // The live region announces the status; the visible cue stays compact.
        <span
          aria-hidden="true"
          title={description}
          data-testid="workspace-reconnecting-indicator"
          className="inline-flex flex-shrink-0 animate-pulse items-center justify-center text-amber-600 motion-reduce:animate-none dark:text-amber-400"
        >
          <WifiOff className="h-4 w-4" />
        </span>
      )}
    </>
  );
}
