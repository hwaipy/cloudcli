import { useSyncExternalStore } from 'react';

type PendingInput = { askedAt: number };
const OLD_INPUT_AGE_MS = 10 * 60 * 1000;
// Keep only question identity/timing, never answers or message bodies, scoped to the Hub account.
let scope = '';
// Each pending question retains its original time across repeat notifications and history refreshes.
let waiting = new Map<string, Map<string, PendingInput>>();
// A later round makes older questions eligible to age out of the sidebar badge only.
let latestRoundStarts = new Map<string, number>();
const listeners = new Set<() => void>();
// One timer updates idle sidebar badges at their expiry without per-row polling.
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
function time(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function isVisible(sessionId: string, input: PendingInput, now: number) {
  return input.askedAt >= (latestRoundStarts.get(sessionId) ?? 0) || now - input.askedAt < OLD_INPUT_AGE_MS;
}
function scheduleExpiry() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const now = Date.now();
  let next = Infinity;
  for (const [id, inputs] of waiting) for (const input of inputs.values()) {
    const expires = input.askedAt + OLD_INPUT_AGE_MS;
    if (input.askedAt < (latestRoundStarts.get(id) ?? 0) && expires > now) next = Math.min(next, expires);
  }
  if (Number.isFinite(next)) expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    listeners.forEach(listener => listener());
    scheduleExpiry();
  }, Math.max(1, next - now));
}
function publish() {
  try {
    if (scope) sessionStorage.setItem(`cloudcli-input-status:${scope}`, JSON.stringify({
      version: 2, waiting: [...waiting].map(([id, inputs]) => [id, [...inputs]]), rounds: [...latestRoundStarts],
    }));
  } catch { /* Storage is optional. */ }
  scheduleExpiry();
  listeners.forEach(listener => listener());
}
/** WebSocket auth owns the account scope; prevents status leaking between accounts. */
export function scopeSessionInputStatus(account: string) {
  if (scope === account) return;
  scope = account; waiting = new Map(); latestRoundStarts = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(`cloudcli-input-status:${scope}`) || '[]');
    const entries = Array.isArray(saved) ? saved : saved.version === 2 && Array.isArray(saved.waiting) ? saved.waiting : [];
    for (const [id, inputs] of entries) {
      if (typeof id !== 'string' || !Array.isArray(inputs)) continue;
      const restored = new Map<string, PendingInput>();
      for (const input of inputs) {
        // Old clients stored keys only; preserve them until history supplies timing.
        if (typeof input === 'string') restored.set(input, { askedAt: Date.now() });
        else if (Array.isArray(input) && typeof input[0] === 'string' && time(input[1]?.askedAt)) restored.set(input[0], { askedAt: input[1].askedAt });
      }
      waiting.set(id, restored);
    }
    if (Array.isArray(saved.rounds)) for (const [id, startedAt] of saved.rounds) if (typeof id === 'string' && time(startedAt)) latestRoundStarts.set(id, startedAt);
  } catch { /* A damaged status cache is rebuilt from history and live events. */ }
  scheduleExpiry();
  listeners.forEach(listener => listener());
}
/** History reconciles question timing without clearing native requests or disabling old question controls. */
export function reconcileSessionInputStatus(sessionId: string, questions: Array<{ title: string; answered?: boolean; askedAt?: number }>, latestRoundStartedAt?: number) {
  const previous = waiting.get(sessionId);
  const inputs = new Map([...(previous ?? [])].filter(([key]) => key.startsWith('native:')));
  for (const question of questions) if (!question.answered) {
    const key = `async:${question.title}`;
    inputs.set(key, { askedAt: time(question.askedAt) ?? previous?.get(key)?.askedAt ?? Date.now() });
  }
  if (time(latestRoundStartedAt)) latestRoundStarts.set(sessionId, Math.max(latestRoundStarts.get(sessionId) ?? 0, latestRoundStartedAt!));
  waiting.set(sessionId, inputs); publish();
}
/** WebSocketContext consumes this before fan-out so off-screen sessions also age their badges. */
export function receiveSessionInputEvent(event: Record<string, unknown>) {
  if (typeof event.sessionId !== 'string') return;
  const id = event.sessionId;
  const inputs = new Map(waiting.get(id) ?? []);
  const round = time(event.runStartedAt);
  const nextRound = Math.max(latestRoundStarts.get(id) ?? 0, round ?? 0);
  let changed = nextRound !== (latestRoundStarts.get(id) ?? 0);
  latestRoundStarts.set(id, nextRound);
  const add = (key: string) => {
    const prior = inputs.get(key);
    if (!prior || (round && round >= nextRound && prior.askedAt < round)) {
      inputs.set(key, { askedAt: time(event.timestamp) ?? Date.now() }); changed = true;
    }
  };
  if (Array.isArray(event.codexQuestions)) for (const question of event.codexQuestions) {
    if (question && typeof question.title === 'string') add(`async:${question.title}`);
  }
  if (event.role === 'user' && typeof event.content === 'string') for (const match of event.content.matchAll(/(?:^|\n)回答「([^」]+)」：[ \t]*([^\n]+)/g)) changed = inputs.delete(`async:${match[1]}`) || changed;
  if (event.kind === 'permission_request' && (event.toolName === 'AskUserQuestion' || event.toolName === 'request_user_input')) add(`native:${String(event.requestId)}`);
  if (event.kind === 'permission_resolved' || event.kind === 'permission_cancelled') changed = inputs.delete(`native:${String(event.requestId)}`) || changed;
  if (!changed) return;
  waiting.set(id, inputs); publish();
}
/** Sidebar consumes a stable boolean snapshot, independent of the selected session. */
export function useSessionNeedsInput(sessionId: string): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => [...(waiting.get(sessionId)?.values() ?? [])].some(input => isVisible(sessionId, input, Date.now())));
}
