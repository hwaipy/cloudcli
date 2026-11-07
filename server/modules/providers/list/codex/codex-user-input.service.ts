import { randomUUID } from 'node:crypto';

import { createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/index.js';

type Question = { id: string; question: string; header: string; options: Array<{ label: string; description: string }>; isSecret: boolean };
type PendingQuestion = {
  sessionId: string; rpcId: string | number; itemId: string; questions: Question[];
  writer: ProviderRuntimeWriter; respond: (result: unknown) => void;
  input: { questions: Question[]; isBlocking: boolean }; receivedAt: Date;
};
const record = (value: unknown): AnyRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
function emit(pending: PendingQuestion, fields: AnyRecord & { kind: Parameters<typeof createNormalizedMessage>[0]['kind'] }): void {
  const message = createNormalizedMessage({ provider: 'codex', sessionId: pending.sessionId, ...fields });
  try { pending.writer.send(pending.writer.isWebSocketWriter ? message : JSON.stringify(message)); }
  catch { console.warn('[Codex questions] Delivery deferred; reconnect can recover pending questions.'); }
}

/** Used by the Codex App Server runtime to bridge question RPCs to the provider-neutral permission UI and replay pending prompts. */
export class CodexUserInputRequests {
  private readonly pending = new Map<string, PendingQuestion>();

  receive(sessionId: string, rpcId: string | number, params: AnyRecord, writer: ProviderRuntimeWriter, respond: (result: unknown) => void): boolean {
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 20 || typeof params.itemId !== 'string') return false;
    const questions: Question[] = [];
    for (const raw of params.questions) {
      const q = record(raw);
      if (typeof q.id !== 'string' || !q.id || questions.some((prior) => prior.id === q.id) || typeof q.question !== 'string' || !q.question.trim()) return false;
      if (q.options != null && !Array.isArray(q.options)) return false;
      const options = (q.options ?? []).map(record);
      if (options.some((option: AnyRecord) => typeof option.label !== 'string' || !option.label)) return false;
      questions.push({ id: q.id, question: q.question, header: typeof q.header === 'string' ? q.header : '', isSecret: q.isSecret === true,
        options: options.map((option: AnyRecord) => ({ label: option.label, description: typeof option.description === 'string' ? option.description : '' })) });
    }
    if ([...this.pending.values()].some((pending) => pending.sessionId === sessionId && pending.rpcId === rpcId)) return true;
    const requestId = `codex-question-${randomUUID()}`;
    const pending: PendingQuestion = { sessionId, rpcId, itemId: params.itemId, questions, writer, respond,
      input: { questions, isBlocking: params.isBlocking !== false }, receivedAt: new Date() };
    this.pending.set(requestId, pending);
    emit(pending, { id: params.itemId, kind: 'tool_use', role: 'assistant', toolName: 'AskUserQuestion', toolId: params.itemId, toolInput: pending.input });
    emit(pending, { kind: 'permission_request', requestId, toolName: 'AskUserQuestion', input: pending.input });
    return true;
  }

  updateWriter(sessionId: string, writer: ProviderRuntimeWriter): void {
    for (const pending of this.pending.values()) if (pending.sessionId === sessionId) pending.writer = writer;
  }

  listPending(sessionId: string): unknown[] {
    return [...this.pending].filter(([, pending]) => pending.sessionId === sessionId).map(([requestId, pending]) => ({
      requestId, sessionId, provider: 'codex', toolName: 'AskUserQuestion', input: pending.input, receivedAt: pending.receivedAt,
    }));
  }

  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    const displayAnswers: Record<string, string> = Object.create(null);
    const submitted = record(record(decision.updatedInput).answers);
    if (decision.allow) {
      for (const question of pending.questions) {
        const raw = submitted[question.id] ?? submitted[question.question];
        const labels = typeof raw === 'string' ? (raw.trim() ? [raw] : []) : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
        if (labels.length) {
          answers[question.id] = { answers: labels };
          displayAnswers[question.id] = question.isSecret ? '••••••••' : labels.join(', ');
        }
      }
    }
    this.pending.delete(requestId); // A second browser must never answer the same RPC twice.
    try {
      pending.respond({ answers });
      emit(pending, { id: pending.itemId, kind: 'tool_use', role: 'assistant', toolName: 'AskUserQuestion', toolId: pending.itemId,
        toolInput: { ...pending.input, answers: displayAnswers } });
      emit(pending, { kind: 'permission_resolved', requestId });
    } catch {
      emit(pending, { kind: 'permission_cancelled', requestId, reason: 'Codex connection unavailable' });
    }
  }

  finishTurn(sessionId: string, cancelled: boolean): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId === sessionId && (cancelled || pending.input.isBlocking)) this.cancel(sessionId, pending.rpcId);
    }
  }

  cancel(sessionId: string, rpcId?: string | number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId || (rpcId !== undefined && pending.rpcId !== rpcId)) continue;
      this.pending.delete(requestId);
      emit(pending, { kind: 'permission_cancelled', requestId, reason: 'Codex cleared this question' });
    }
  }
}
