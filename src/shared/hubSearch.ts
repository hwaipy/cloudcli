import { api } from '@/shared/api';
import { isHubRuntime, registerHubResourceBackend } from '@/shared/utils';

export type ConversationSearchStream = {
  close: () => void;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
};

/** Sidebar search fans out across backend owners without changing workspace state. */
export function openConversationSearch(query: string): ConversationSearchStream {
  if (!isHubRuntime()) return new EventSource(api.searchConversationsUrl(query));
  let closed = false;
  const sources = new Set<EventSource>();
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const titles = new Map<string, unknown[]>();
  const counts = new Map<string, { totalMatches: number; scannedProjects: number; totalProjects: number }>();
  const emit = (type: string, body: unknown = {}) => {
    if (closed) return;
    const event = new MessageEvent(type, { data: JSON.stringify(body) });
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const totals = () => [...counts.values()].reduce((a, b) => ({
    totalMatches: a.totalMatches + b.totalMatches,
    scannedProjects: a.scannedProjects + b.scannedProjects,
    totalProjects: a.totalProjects + b.totalProjects,
  }), { totalMatches: 0, scannedProjects: 0, totalProjects: 0 });
  void (async () => {
    try {
      const response = await api.hub.backends();
      if (!response.ok) throw new Error('Backend discovery failed');
      const { backends } = await response.json() as { backends: Array<{ id: string; online?: boolean }> };
      if (closed) return;
      const available = backends.filter((backend) => backend.online !== false);
      let remaining = available.length;
      if (!remaining) { emit('done'); return; }
      for (const backend of available) {
        const source = new EventSource(api.searchConversationsUrl(query, 50, backend.id));
        sources.add(source);
        const finish = () => {
          if (!sources.delete(source)) return;
          source.close();
          if (--remaining === 0) emit('done');
        };
        source.addEventListener('title-results', (event) => {
          try {
            const body = JSON.parse(event.data);
            for (const row of body.titleResults ?? []) {
              registerHubResourceBackend('session', row.sessionId, backend.id);
              if (row.projectId) registerHubResourceBackend('project', row.projectId, backend.id);
              row.__hubBackendId = backend.id;
            }
            titles.set(backend.id, body.titleResults ?? []);
            emit('title-results', { titleResults: [...titles.values()].flat() });
          } catch { /* A malformed event cannot invalidate another backend's search. */ }
        });
        for (const type of ['result', 'progress']) source.addEventListener(type, (event) => {
          try {
            const body = JSON.parse(event.data);
            counts.set(backend.id, {
              totalMatches: Number(body.totalMatches) || 0,
              scannedProjects: Number(body.scannedProjects) || 0,
              totalProjects: Number(body.totalProjects) || 0,
            });
            if (body.projectResult) {
              const project = body.projectResult;
              if (project.projectId) registerHubResourceBackend('project', project.projectId, backend.id);
              for (const session of project.sessions ?? []) registerHubResourceBackend('session', session.sessionId, backend.id);
              project.__hubBackendId = backend.id;
            }
            emit(type, { ...body, ...totals() });
          } catch { /* Ignore invalid frames. */ }
        });
        source.addEventListener('done', finish);
        source.addEventListener('error', finish);
      }
    } catch { emit('error'); }
  })();
  return {
    close: () => { closed = true; for (const source of sources) source.close(); sources.clear(); },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
  };
}
