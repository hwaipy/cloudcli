import { resolve as resolvePath } from 'node:path';

import { isolatedCodexLaunch, resolveIsolatedProject, stageIsolationAttachments } from '@/modules/project-isolation/index.js';
import type { CodexProcessLaunch, NormalizedMessage } from '@/shared/types.js';

import {
  appendFilesInputTag,
  createCompleteMessage,
  createNormalizedMessage,
  normalizeImageDescriptors,
} from '@/shared/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { CodexAppServerConnection } from '@/modules/providers/list/codex/codex-app-server-connection.provider.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderPermissionDecision } from '@/shared/index.js';

import { CodexUserInputRequests } from './codex-user-input.service.js';

type ActiveTurn = {
  id: string | null;
  done: Promise<'completed' | 'failed' | 'interrupted'>;
  resolve(status: 'completed' | 'failed' | 'interrupted'): void;
  connectionError: Error | null;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  appSessionId: string;
  aborted: boolean;
  errorShown: boolean;
  itemText: Map<string, string>;
  itemOutput: Map<string, string>;
  items: Map<string, AnyRecord>;
  turnTimer: ReturnType<typeof setTimeout> | null;
  interruptTimer: ReturnType<typeof setTimeout> | null;
};

type AppServerConnection = Pick<CodexAppServerConnection, 'call' | 'subscribe' | 'close' | 'onRequest' | 'respond'>;

type LiveThread = {
  connection: AppServerConnection;
  threadId: string;
  model?: string;
  active: ActiveTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  isolationProjectId?: string;
  syncState?: CodexProcessLaunch['syncState'];
};

const IDLE_MS = 10 * 60_000;
// A live turn can legitimately run for hours. Leave the total duration uncapped
// unless an operator explicitly sets a positive limit in minutes.
const configuredTurnTimeoutMinutes = Number(process.env.CLOUDCLI_CODEX_TURN_TIMEOUT_MINUTES ?? 0);
const TURN_TIMEOUT_MS = Number.isFinite(configuredTurnTimeoutMinutes) && configuredTurnTimeoutMinutes > 0
  ? Math.min(configuredTurnTimeoutMinutes * 60_000, 2_147_483_647)
  : 0;
const INTERRUPT_GRACE_MS = 5_000;

function send(writer: ProviderRuntimeWriter, message: unknown): void {
  if (writer.isWebSocketWriter) writer.send(message);
  else writer.send(JSON.stringify(message));
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

function permissionOptions(mode: unknown): { sandbox: 'workspace-write' | 'danger-full-access'; approvalPolicy: 'never' | 'on-request' } {
  return mode === 'bypassPermissions'
    ? { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    : { sandbox: 'workspace-write', approvalPolicy: mode === 'acceptEdits' ? 'never' : 'on-request' };
}

function emitItem(active: ActiveTurn, item: AnyRecord, overrides: AnyRecord = {}): void {
  const itemId = String(item.id || overrides.itemId || '');
  const kind = String(item.type || '');
  const fields: AnyRecord = { type: 'item', itemId, status: item.status, ...overrides };
  switch (kind) {
    case 'agentMessage':
      fields.itemType = 'agent_message';
      fields.message = { role: 'assistant', content: overrides.text ?? item.text ?? '' };
      fields.phase = item.phase;
      fields.codexQuestions = item.questions;
      if (!fields.message.content) return;
      break;
    case 'reasoning':
      fields.itemType = 'reasoning';
      fields.message = { role: 'assistant', content: overrides.text ?? (Array.isArray(item.summary) ? item.summary.join('') : '') };
      if (!fields.message.content) return;
      break;
    case 'commandExecution':
      fields.itemType = 'command_execution';
      fields.command = item.command;
      fields.output = overrides.output ?? item.aggregatedOutput ?? '';
      fields.exitCode = item.exitCode;
      fields.status = item.status === 'inProgress' ? 'in_progress' : item.status;
      break;
    case 'fileChange':
      fields.itemType = 'file_change';
      fields.changes = item.changes;
      break;
    case 'mcpToolCall':
      fields.itemType = 'mcp_tool_call';
      fields.server = item.server;
      fields.tool = item.tool;
      fields.arguments = item.arguments;
      fields.result = item.result;
      fields.error = item.error;
      fields.status = item.status === 'inProgress' ? 'in_progress' : item.status;
      break;
    case 'webSearch':
      fields.itemType = 'web_search';
      fields.query = item.query;
      break;
    case 'plan':
      fields.itemType = 'agent_message';
      fields.message = { role: 'assistant', content: item.text ?? '' };
      fields.phase = 'commentary';
      if (!fields.message.content) return;
      break;
    default:
      return;
  }
  for (const message of active.context.normalizeMessage(fields, active.appSessionId)) {
    send(active.writer, message);
  }
}

function handleNotification(live: LiveThread, message: { method?: string; params?: unknown }): void {
  const active = live.active;
  if (!active || !message.method) return;
  const params = asRecord(message.params);
  if (params.threadId !== live.threadId) return;
  const turnId = typeof params.turnId === 'string' ? params.turnId : asRecord(params.turn).id;
  if (active.id && turnId && turnId !== active.id) return;

  switch (message.method) {
    case 'turn/started':
      if (typeof turnId === 'string') active.id = turnId;
      break;
    case 'item/started':
    case 'item/completed':
      {
        const item = asRecord(params.item);
        if (typeof item.id === 'string') active.items.set(item.id, item);
        emitItem(active, item);
      }
      break;
    case 'item/agentMessage/delta': {
      const id = String(params.itemId || '');
      const text = (active.itemText.get(id) ?? '') + String(params.delta ?? '');
      active.itemText.set(id, text);
      emitItem(active, { ...active.items.get(id), type: 'agentMessage', id, text }, { text });
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const id = String(params.itemId || '');
      const output = (active.itemOutput.get(id) ?? '') + String(params.delta ?? '');
      active.itemOutput.set(id, output);
      emitItem(active, { ...active.items.get(id), type: 'commandExecution', id, status: 'inProgress' }, { output });
      break;
    }
    case 'item/reasoning/summaryTextDelta': {
      const id = String(params.itemId || '');
      const text = (active.itemText.get(id) ?? '') + String(params.delta ?? '');
      active.itemText.set(id, text);
      emitItem(active, { type: 'reasoning', id }, { text });
      break;
    }
    case 'thread/tokenUsage/updated': {
      const usage = asRecord(params.tokenUsage);
      const cumulative = asRecord(usage.total);
      const last = asRecord(usage.last);
      const sessionTotalTokens = Number(cumulative.totalTokens);
      const inputTokens = Number(last.inputTokens);
      const outputTokens = Number(last.outputTokens);
      if (!Number.isFinite(sessionTotalTokens) || sessionTotalTokens < 0
        || !Number.isFinite(inputTokens) || inputTokens < 0
        || !Number.isFinite(outputTokens) || outputTokens < 0) break;
      const used = inputTokens + outputTokens;
      const contextWindow = Number(usage.modelContextWindow);
      send(active.writer, createNormalizedMessage({
        kind: 'status', text: 'token_budget', provider: 'codex', sessionId: active.appSessionId,
        tokenBudget: {
          used, contextUsed: used, sessionTotalTokens, inputTokens, outputTokens,
          breakdown: { input: inputTokens, output: outputTokens },
          ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { total: contextWindow } : {}),
        },
      }));
      break;
    }
    case 'error': {
      const error = asRecord(params.error);
      active.errorShown = true;
      send(active.writer, createNormalizedMessage({
        kind: 'error', provider: 'codex', sessionId: active.appSessionId,
        content: String(error.message || 'Codex App Server error'),
      }));
      break;
    }
    case 'turn/completed': {
      const turn = asRecord(params.turn);
      const status = turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed';
      active.resolve(status);
      break;
    }
  }
}

type RuntimeOptions = {
  createConnection?: (launch?: CodexProcessLaunch) => AppServerConnection;
  resolveIsolation?: typeof resolveIsolatedProject;
  idleMs?: number;
  turnTimeoutMs?: number;
  interruptGraceMs?: number;
};

/** Builds the experimental runtime; provider tests inject a scripted connection to verify lifecycle behavior. */
export function createCodexAppServerRuntime({
  resolveIsolation = resolveIsolatedProject,
  createConnection = (launch?: CodexProcessLaunch) => new CodexAppServerConnection(launch),
  idleMs = IDLE_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  interruptGraceMs = INTERRUPT_GRACE_MS,
}: RuntimeOptions = {}) {
  const liveThreads = new Map<string, LiveThread>();
  const questions = new CodexUserInputRequests();

  function dispose(appSessionId: string): void {
    const live = liveThreads.get(appSessionId);
    if (!live) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    liveThreads.delete(appSessionId);
    questions.cancel(appSessionId);
    live.connection.close();
  }

  function scheduleIdleClose(appSessionId: string, live: LiveThread): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (questions.listPending(appSessionId).length) return;
    live.idleTimer = setTimeout(() => {
      if (!live.active && liveThreads.get(appSessionId) === live) dispose(appSessionId);
    }, idleMs);
    live.idleTimer.unref();
  }

async function acquireThread(appSessionId: string, providerSessionId: string | null, options: AnyRecord): Promise<LiveThread> {
  const isolatedProject = resolveIsolation(options);
  let live = liveThreads.get(appSessionId);
  if (live && live.isolationProjectId !== isolatedProject?.project_id) { dispose(appSessionId); live = undefined; }
  if (live && providerSessionId && live.threadId !== providerSessionId) {
    dispose(appSessionId); // An edit/fork changed the native thread id.
    live = undefined;
  }
  if (live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    return live;
  }
  const launch = isolatedProject ? await isolatedCodexLaunch(isolatedProject) : undefined;
  const connection = createConnection(launch);
  const permissions = permissionOptions(options.permissionMode);
  if (isolatedProject) permissions.sandbox = 'danger-full-access'; // The outer container is the enforced filesystem boundary.
  const cwd = String(options.cwd || options.projectPath || process.cwd());
  try {
    const response = asRecord(await connection.call(providerSessionId ? 'thread/resume' : 'thread/start', providerSessionId
      ? { threadId: providerSessionId, excludeTurns: true, cwd, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox }
      : { cwd, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox, model: options.model, serviceName: 'cloudcli' }));
    const threadId = asRecord(response.thread).id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex App Server returned no thread id.');
    live = { connection, threadId, model: typeof response.model === 'string' ? response.model : options.model, active: null, idleTimer: null, isolationProjectId: isolatedProject?.project_id, syncState: launch?.syncState };
    liveThreads.set(appSessionId, live);
    const owned = live;
    connection.onRequest((id, method, raw) => {
      if (method !== 'item/tool/requestUserInput' && method !== 'tool/requestUserInput') return false;
      const params = asRecord(raw);
      const active = owned.active;
      if (!active || params.threadId !== owned.threadId || (active.id && params.turnId !== active.id)) return false;
      return questions.receive(appSessionId, id, params, active.writer, (result) => connection.respond(id, result));
    });
    connection.subscribe(
      (message) => {
        if (message.method === 'serverRequest/resolved') {
          const params = asRecord(message.params);
          if (params.threadId === owned.threadId && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
            questions.cancel(appSessionId, params.requestId);
            if (!owned.active) scheduleIdleClose(appSessionId, owned);
          }
        }
        handleNotification(owned, message);
      },
      (error) => {
        questions.cancel(appSessionId);
        if (owned.active) {
          owned.active.connectionError = error;
          owned.active.resolve('failed');
        }
        if (liveThreads.get(appSessionId) === owned) liveThreads.delete(appSessionId);
        if (owned.idleTimer) clearTimeout(owned.idleTimer);
      },
    );
    return live;
  } catch (error) {
    connection.close();
    throw error;
  }
}

return {
  permissions: {
    listPending: (sessionId: string) => questions.listPending(sessionId),
    resolve: (requestId: string, decision: ProviderPermissionDecision) => {
      questions.resolve(requestId, decision);
      for (const [sessionId, live] of liveThreads) if (!live.active) scheduleIdleClose(sessionId, live);
    },
  },
  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const appSessionId = String(options.sessionId || '');
    if (!appSessionId) throw new Error('App Server requires an app session id.');
    const providerSessionId = context.resolveProviderSessionId(appSessionId);
    const model = await context.resolveResumeModel(appSessionId, options.model);
    const live = await acquireThread(appSessionId, providerSessionId, { ...options, model });
    if (live.active) throw new Error('Codex App Server already has an active turn for this session.');
    if (!providerSessionId) {
      writer.setSessionId?.(live.threadId);
      send(writer, createNormalizedMessage({ kind: 'session_created', newSessionId: live.threadId, sessionId: live.threadId, provider: 'codex' }));
    }

    let resolveDone!: ActiveTurn['resolve'];
    const done = new Promise<'completed' | 'failed' | 'interrupted'>((resolve) => {
      resolveDone = resolve;
    });
    const active: ActiveTurn = {
      id: null, done, resolve: resolveDone, connectionError: null,
      writer, context, appSessionId, aborted: false, errorShown: false,
      itemText: new Map(), itemOutput: new Map(), items: new Map(),
      turnTimer: null, interruptTimer: null,
    };
    questions.updateWriter(appSessionId, writer);
    live.active = active;
    if (turnTimeoutMs > 0) {
      active.turnTimer = setTimeout(() => {
        if (live.active !== active) return;
        const limit = turnTimeoutMs >= 60_000
          ? `${Number((turnTimeoutMs / 60_000).toFixed(2))} minutes`
          : `${turnTimeoutMs} ms`;
        active.connectionError = new Error(`Codex App Server turn reached its configured running limit (${limit}).`);
        active.resolve('failed');
      }, turnTimeoutMs);
      active.turnTimer.unref();
    }
    let failure: Error | null = null;
    try {
      const cwd = String(options.cwd || options.projectPath || process.cwd());
      const isolated = live.isolationProjectId ? resolveIsolation(options) : null;
      const files = isolated ? await stageIsolationAttachments(isolated, Array.isArray(options.files) ? options.files : [], Number(writer.userId) || undefined) : options.files;
      const imageFiles = isolated ? await stageIsolationAttachments(isolated, Array.isArray(options.images) ? options.images : [], Number(writer.userId) || undefined) : options.images;
      const prompt = appendFilesInputTag(command, files);
      const images = normalizeImageDescriptors(imageFiles);
      const input = [
        { type: 'text', text: prompt || (images.length ? 'Please analyze the attached image(s).' : ''), text_elements: [] },
        ...images.map((image) => ({ type: 'localImage', path: resolvePath(cwd, image.path) })),
      ];
      const permissions = permissionOptions(options.permissionMode);
      if (live.isolationProjectId) permissions.sandbox = 'danger-full-access';
      const collaborationModel = model || live.model;
      const result = asRecord(await live.connection.call('turn/start', {
        threadId: live.threadId, input, cwd,
        ...(collaborationModel ? { collaborationMode: {
          mode: options.permissionMode === 'plan' ? 'plan' : 'default',
          settings: { model: collaborationModel, reasoning_effort: typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : null, developer_instructions: null },
        } } : {}),
        ...(model ? { model } : {}),
        ...(typeof options.effort === 'string' && options.effort !== 'default' ? { effort: options.effort } : {}),
        approvalPolicy: permissions.approvalPolicy,
        sandboxPolicy: permissions.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
      }));
      const turnId = asRecord(result.turn).id;
      if (typeof turnId !== 'string') throw new Error('Codex App Server returned no turn id.');
      active.id = turnId;
      // Enrich the gateway-owned input instead of interpreting userMessage items.
      // The stable row id lets the frontend replace, then reconcile by native turn.
      const acceptedInput = options.acceptedUserMessage as NormalizedMessage | undefined;
      if (acceptedInput?.kind === 'text' && acceptedInput.role === 'user') {
        writer.send({ ...acceptedInput, transcriptAnchorId: turnId });
      }
      const status = await done;
      const snapshots = await live.syncState?.();
      if (snapshots?.length) {
        // The registry imports this runtime; load its indexer only after runtime initialization.
        const { sessionSynchronizerService } = await import('@/modules/providers/services/session-synchronizer.service.js');
        for (const file of snapshots) await sessionSynchronizerService.synchronizeProviderFile('codex', file);
      }
      if (status === 'failed') throw active.connectionError ?? new Error('Codex App Server turn failed.');
      if (status === 'interrupted' || active.aborted) return;
      send(writer, createCompleteMessage({ provider: 'codex', sessionId: appSessionId, actualSessionId: live.threadId, exitCode: 0 }));
      notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: options.sessionId, stopReason: 'completed' });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (!active.aborted) {
        if (!active.errorShown) send(writer, createNormalizedMessage({ kind: 'error', provider: 'codex', sessionId: appSessionId, content: failure.message }));
        send(writer, createCompleteMessage({ provider: 'codex', sessionId: appSessionId, exitCode: 1 }));
        notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: options.sessionId, error: failure });
      }
    } finally {
      if (active.turnTimer) clearTimeout(active.turnTimer);
      if (active.interruptTimer) clearTimeout(active.interruptTimer);
      questions.finishTurn(appSessionId, active.aborted || Boolean(failure));
      live.active = null;
      if (failure) dispose(appSessionId);
      else if (liveThreads.get(appSessionId) === live) scheduleIdleClose(appSessionId, live);
    }
  },

  async steer(appSessionId: string, text: string): Promise<boolean> {
    const live = liveThreads.get(appSessionId);
    const active = live?.active;
    if (!live || !active?.id || active.aborted || !text.trim()) return false;
    const result = asRecord(await live.connection.call('turn/steer', {
      threadId: live.threadId,
      expectedTurnId: active.id,
      input: [{ type: 'text', text, text_elements: [] }],
    }));
    return result.turnId === active.id;
  },

  async abort(appSessionId: string): Promise<boolean> {
    const live = liveThreads.get(appSessionId);
    const active = live?.active;
    if (!live || !active?.id) return false;
    active.aborted = true;
    try {
      await live.connection.call('turn/interrupt', { threadId: live.threadId, turnId: active.id });
      // An accepted interrupt can still fail to emit turn/completed. Close the
      // held child after a short grace period so the next turn can resume.
      if (live.active === active) {
        active.interruptTimer = setTimeout(() => {
          if (live.active !== active) return;
          active.resolve('interrupted');
          dispose(appSessionId);
        }, interruptGraceMs);
        active.interruptTimer.unref();
      }
      return true;
    } catch {
      active.aborted = false;
      return false;
    }
  },
  async shutdownAll(): Promise<void> {
    const sessionIds = [...liveThreads.keys()];
    let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.allSettled(sessionIds.map((sessionId) => this.abort(sessionId))),
        new Promise<void>((resolve) => {
          shutdownTimer = setTimeout(resolve, 3_000);
          shutdownTimer.unref();
        }),
      ]);
    } finally {
      if (shutdownTimer) clearTimeout(shutdownTimer);
    }
    for (const sessionId of sessionIds) dispose(sessionId);
  },
};
}

/** Used by the Codex provider when the App Server flag is enabled. */
export const codexAppServerRuntime = createCodexAppServerRuntime();
