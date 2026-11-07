import { memo, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

it('keeps a memoized chat live while its workspace-owned cache survives remounts', () => {
  let store: ReturnType<typeof useSessionStore>;
  const Transcript = memo(({ historyStore, revision: _revision }: {
    historyStore: ReturnType<typeof useSessionStore>;
    revision: number;
  }) => <div>{historyStore.getMessages('session').map(message => message.content).join(' ')}</div>);
  function Workspace({ reset }: { reset: number }) {
    const historyStore = useSessionStore();
    useEffect(() => {
      store = historyStore;
      historyStore.setActiveSession('session');
    }, [historyStore]);
    return <Transcript key={reset} historyStore={historyStore} revision={historyStore.getRevision()} />;
  }
  const view = render(<Workspace reset={0} />);
  act(() => store.appendRealtime('session', {
    id: 'answer', sessionId: 'session', provider: 'codex', kind: 'text', role: 'assistant',
    content: 'first delta', timestamp: '2026-11-05T00:00:00Z',
  }));
  expect(view.container.textContent).toBe('first delta');
  view.rerender(<Workspace reset={1} />);
  expect(view.container.textContent).toBe('first delta');
  act(() => store.appendRealtime('session', {
    id: 'answer', sessionId: 'session', provider: 'codex', kind: 'text', role: 'assistant',
    content: 'final delta', timestamp: '2026-11-05T00:00:01Z',
  }));
  expect(view.container.textContent).toBe('final delta');
});
