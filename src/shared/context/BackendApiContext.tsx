import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { api, createBackendApi } from '@/shared/api';

// A scoped client belongs to an editor subtree, never to a mutable global backend selection.
const BackendApiContext = createContext({ api, backendId: undefined as string | undefined });

/** Backend management scopes descendant provider editors without changing global application routing. */
export function BackendApiProvider({ backendId, children }: { backendId: string; children: ReactNode }) {
  const value = useMemo(() => ({ api: createBackendApi(backendId), backendId }), [backendId]);
  return <BackendApiContext.Provider value={value}>{children}</BackendApiContext.Provider>;
}

/** Provider editors and their data hooks use the selected management backend's immutable client. */
export function useBackendApi() { return useContext(BackendApiContext); }
