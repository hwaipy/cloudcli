import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const CODEX_HOME_PATH = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG_PATH = path.join(CODEX_HOME_PATH, 'config.toml');
const CODEX_MODELS_CACHE_PATH = path.join(CODEX_HOME_PATH, 'models_cache.json');

/** Read the CLI's account-specific visible catalog without treating hidden/internal entries as choices. */
const readCachedModels = (raw: unknown): ProviderModelsDefinition | null => {
  const cache = readObjectRecord(raw);
  if (!Array.isArray(cache?.models)) return null;

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const value of cache.models) {
    const model = readObjectRecord(value);
    const slug = readOptionalString(model?.slug);
    if (!slug || model?.visibility !== 'list' || model.supported_in_api === false || seen.has(slug)) continue;

    seen.add(slug);
    const effortValues = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
        .map((level) => readOptionalString(readObjectRecord(level)?.effort))
        .filter((level): level is string => Boolean(level))
      : [];
    const defaultEffort = readOptionalString(model.default_reasoning_level);
    options.push({
      value: slug,
      label: readOptionalString(model.display_name) || slug,
      ...(readOptionalString(model.description) ? { description: readOptionalString(model.description) } : {}),
      ...(effortValues.length > 0 ? {
        effort: {
          default: defaultEffort && effortValues.includes(defaultEffort) ? defaultEffort : effortValues[0],
          values: effortValues.map((effort) => ({ value: effort })),
        },
      } : {}),
    });
  }

  if (options.length === 0) return null;
  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === CODEX_PREDEFINED_MODELS.DEFAULT)
      ? CODEX_PREDEFINED_MODELS.DEFAULT
      : options[0].value,
  };
};

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  constructor(private readonly modelsCachePath = CODEX_MODELS_CACHE_PATH) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const raw = await readFile(this.modelsCachePath, 'utf8');
      return readCachedModels(JSON.parse(raw)) ?? CODEX_PREDEFINED_MODELS;
    } catch {
      return CODEX_PREDEFINED_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
