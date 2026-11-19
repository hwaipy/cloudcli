import { readFile } from 'node:fs/promises';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  readObjectRecord,
  readOptionalString,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

async function readNativeClaudeModels(): Promise<unknown> {
  // The input stream never emits a prompt: supportedModels is an SDK control
  // request, not an inference turn. No project transcript should be persisted.
  const input = (async function* () { yield* await new Promise<never[]>(() => {}); })();
  const run = query({ prompt: input, options: {
    cwd: os.tmpdir(), persistSession: false, settingSources: [],
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
    env: { ...process.env },
  } });
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      run.supportedModels(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Claude model discovery timed out')), 10_000); }),
    ]);
  } finally { clearTimeout(timer!); run.close(); }
}

function nativeClaudeCatalog(value: unknown): ProviderModelsDefinition {
  if (!Array.isArray(value)) throw new Error('Invalid Claude model catalog');
  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const entry of value) {
    const row = readObjectRecord(entry);
    const id = readOptionalString(row?.value);
    if (!row || !id || seen.has(id)) continue;
    seen.add(id);
    const displayName = readOptionalString(row.displayName) ?? id;
    const description = readOptionalString(row.description) ?? '';
    const resolved = readOptionalString(row.resolvedModel) ?? '';
    const resolvedVersion = /claude-(opus|sonnet|haiku|fable)-(\d{1,2})-(\d{1,2})(?:-|$)/i.exec(resolved);
    const versionName = /\b(?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*/i.exec(description)?.[0]
      ?? (resolvedVersion ? `${resolvedVersion[1][0].toUpperCase()}${resolvedVersion[1].slice(1)} ${resolvedVersion[2]}.${resolvedVersion[3]}` : null);
    const label = !versionName || displayName.toLowerCase().includes(versionName.toLowerCase())
      ? displayName
      : /\b(?:Opus|Sonnet|Haiku|Fable)\b/i.test(displayName)
        ? displayName.replace(/\b(?:Opus|Sonnet|Haiku|Fable)\b/i, versionName)
        : `${displayName} · ${versionName}`;
    const levels = Array.isArray(row.supportedEffortLevels)
      ? [...new Set(row.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && ['low','medium','high','xhigh','max'].includes(level)))] : [];
    options.push({ value: id, label, description,
      ...(row.supportsEffort !== false && levels.length ? { effort: {
        default: levels.includes('high') ? 'high' : levels[0],
        values: [...levels.map(level => ({ value: level })), ...(levels.includes('xhigh') ? [ULTRACODE_EFFORT_OPTION] : [])],
      } } : {}),
    });
  }
  if (!options.length) throw new Error('Claude reported no models');
  return { OPTIONS: options, DEFAULT: options.some(option => option.value === 'default') ? 'default' : options[0].value };
}

export class ClaudeProviderModels implements IProviderModels {
  private cached: { models: ProviderModelsDefinition; expires: number } | null = null;
  private pending: Promise<ProviderModelsDefinition> | null = null;

  constructor(private readonly readModels = readNativeClaudeModels, private readonly now = Date.now) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (this.cached && this.cached.expires > this.now()) return this.cached.models;
    if (this.pending) return this.pending;
    this.pending = this.readModels().then(raw => {
      const models = nativeClaudeCatalog(raw);
      this.cached = { models, expires: this.now() + 60_000 };
      return models;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
