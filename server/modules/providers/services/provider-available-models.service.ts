import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import type { LLMProvider } from '@/shared/types.js';

/** Model picker catalog for this host; configuration/library catalogs remain independently editable. */
export function createProviderAvailableModelsService(overrides: {
  getAuthStatus?: typeof providerAuthService.getProviderAuthStatus;
  getModels?: typeof providerModelsService.getProviderModels;
} = {}) {
  const auth = overrides.getAuthStatus ?? ((provider) => providerAuthService.getProviderAuthStatus(provider));
  const models = overrides.getModels ?? ((provider) => providerModelsService.getProviderModels(provider));
  return {
    async getAvailableModels(provider: LLMProvider) {
      const status = await auth(provider);
      if (!status.installed || !status.authenticated) return { OPTIONS: [], DEFAULT: '' };
      return models(provider);
    },
  };
}

/** Used by the provider model route when a chat requests executable rather than editable models. */
export const providerAvailableModelsService = createProviderAvailableModelsService();
