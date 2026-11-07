import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchGithubTokenCredentials } from '@/modules/project-creation-wizard/utils/workspaceApi';
import type { GithubTokenCredential } from '@/shared/types';

type UseGithubTokensParams = {
  shouldLoad: boolean;
  selectedTokenId: string;
  backendId?: string;
  onAutoSelectToken: (tokenId: string) => void;
};

export const useGithubTokens = ({
  shouldLoad,
  selectedTokenId,
  backendId,
  onAutoSelectToken,
}: UseGithubTokensParams) => {
  const [tokens, setTokens] = useState<GithubTokenCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasLoadedRef = useRef('');
  const backendKey = backendId ?? 'default';

  useEffect(() => {
    if (!shouldLoad || hasLoadedRef.current === backendKey) {
      return;
    }

    let isDisposed = false;

    const loadTokens = async () => {
      setLoading(true);
      setLoadError(null);

      try {
        const activeTokens = await fetchGithubTokenCredentials(backendId);
        if (isDisposed) {
          return;
        }

        setTokens(activeTokens);
        hasLoadedRef.current = backendKey;

        if (activeTokens.length > 0 && !activeTokens.some((token) => String(token.id) === selectedTokenId)) {
          onAutoSelectToken(String(activeTokens[0].id));
        }
      } catch (error) {
        if (!isDisposed) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load GitHub tokens');
        }
      } finally {
        if (!isDisposed) {
          setLoading(false);
        }
      }
    };

    loadTokens();

    return () => {
      isDisposed = true;
    };
  }, [backendId, backendKey, onAutoSelectToken, selectedTokenId, shouldLoad]);

  const selectedTokenName = useMemo(
    () => tokens.find((token) => String(token.id) === selectedTokenId)?.credential_name || null,
    [selectedTokenId, tokens],
  );

  return {
    tokens,
    loading,
    loadError,
    selectedTokenName,
  };
};
