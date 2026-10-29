import { api, ApiRequestError, readApiErrorMessage } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 *
 * Composer text and the ordered queue travel separately. Text is saved on a
 * debounce. Each queued turn is appended or removed by ID on the server, and
 * the dispatcher sends each turn in order. The browser mirror is only a cache;
 * server hydration remains authoritative.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  id?: string;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessages: StoredQueuedMessage[];
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessages: [] };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
// Counts this page's changes to each scope's queued message, so a hydrate that
// was already in flight when one happened does not put back the older copy.
const queueRevisions = new Map<string, number>();
// The last queue request (append or clear) made for each scope, settled once
// the server has answered it. The next one waits for it, so the server applies
// them in the order they were made: an Edit's clear that reached the server
// after the message re-queued from it would otherwise delete that message.
const queueRequests = new Map<string, Promise<void>>();
// The last clear made for each scope, resolving to whether the server applied it.

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessages: normalizeQueuedMessages(value.queuedMessages ?? value.queuedMessage),
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];
  pendingScopes.clear();

  for (const scope of scopes) {
    // Text only: the server keeps the scope's queued message as it is, and
    // drops the row itself once neither text nor a queued message is left.
    // Deleting the row from here would also delete a message queued from
    // another tab that this page has not heard about yet.
    const text = drafts.get(scope)?.text ?? '';

    // A save that fails must never surface as an unhandled rejection out of a
    // timer callback: the mirror already holds the draft, and the next
    // keystroke re-sends it.
    try {
      void api.user.saveDraft(scope, { text }).catch((error: unknown) => {
        console.error('Failed to save chat draft:', error);
      });
    } catch (error) {
      console.error('Failed to save chat draft:', error);
    }
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

/** Applies a change to this page's copy of a draft; returns whether anything changed. */
function setLocalDraft(scope: string, update: Partial<DraftRecord>): boolean {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessages === current.queuedMessages) {
    return false;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;

  writeMirror();
  notifyListeners();
  return true;
}

function noteQueueChanged(scope: string): void {
  queueRevisions.set(scope, (queueRevisions.get(scope) ?? 0) + 1);
}

/**
 * Sends a scope's queue request once the previous one has been answered, or at
 * once when none is outstanding (a clear must still beat the dispatcher's poll).
 */
function sendQueueRequest<T>(scope: string, send: () => Promise<T>): Promise<T> {
  const previous = queueRequests.get(scope);
  let request: Promise<T>;
  if (previous) {
    request = previous.then(send);
  } else {
    try {
      request = send();
    } catch (error) {
      request = Promise.reject(error);
    }
  }
  const settled = request.then(() => undefined, () => undefined);
  queueRequests.set(scope, settled);
  void settled.then(() => {
    if (queueRequests.get(scope) === settled) {
      queueRequests.delete(scope);
    }
  });
  return request;
}

/** A stored queued message in the shape the composer sends, or null when it has nothing to send. */
function normalizeQueuedMessage(queued: StoredQueuedMessage | null): StoredQueuedMessage | null {
  if (!queued || typeof queued.content !== 'string') {
    return null;
  }

  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  if (setLocalDraft(scope, { text })) {
    queueServerWrite(scope);
  }
}

function normalizeQueuedMessages(value: unknown): StoredQueuedMessage[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => {
    const normalized = normalizeQueuedMessage(isRecord(item) ? item as StoredQueuedMessage : null);
    return normalized ? [normalized] : [];
  });
}

export function readQueuedMessages(scope: string): StoredQueuedMessage[] {
  return drafts.get(scope)?.queuedMessages ?? [];
}

/** Compatibility reader for callers interested only in the next message. */
export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  return readQueuedMessages(scope)[0] ?? null;
}

/** Appends an independent queued turn and adopts the server's ordered list. */
export async function appendQueuedMessage(
  scope: string,
  message: StoredQueuedMessage,
): Promise<{ queuedMessage: StoredQueuedMessage; queuedMessages: StoredQueuedMessage[]; appended: boolean }> {
  const revisionAtRequest = queueRevisions.get(scope) ?? 0;
  const result = await sendQueueRequest(scope, async () => {
    const response = await api.user.appendQueuedMessage(scope, message);
    const payload = (await response.json().catch(() => null)) as {
      queuedMessage?: unknown;
      queuedMessages?: unknown;
      appended?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok) {
      const errorCode = isRecord(payload?.error) ? payload.error.code : undefined;
      throw new ApiRequestError(readApiErrorMessage(payload) ?? `HTTP ${response.status}`, {
        code: typeof errorCode === 'string' ? errorCode : undefined,
        status: response.status,
      });
    }
    const queuedMessage = normalizeQueuedMessage(isRecord(payload?.queuedMessage)
      ? payload.queuedMessage as StoredQueuedMessage : null);
    if (!queuedMessage) throw new Error('The server returned no queued message');
    return {
      queuedMessage,
      queuedMessages: normalizeQueuedMessages(payload?.queuedMessages),
      appended: payload?.appended === true,
    };
  });
  const changedWhileWaiting = (queueRevisions.get(scope) ?? 0) !== revisionAtRequest;
  const queuedMessages = changedWhileWaiting
    ? [...readQueuedMessages(scope).filter((item) => item.id !== result.queuedMessage.id), result.queuedMessage]
    : result.queuedMessages;
  noteQueueChanged(scope);
  setLocalDraft(scope, { queuedMessages });
  return { ...result, queuedMessages };
}

/** Reorders a scope's persisted queue and restores the authoritative copy if it changed meanwhile. */
export async function reorderQueuedMessages(scope: string, orderedIds: string[]): Promise<StoredQueuedMessage[]> {
  const current = readQueuedMessages(scope);
  const expectedIds = current.map((message) => message.id ?? '');
  if (expectedIds.length < 2 || expectedIds.some((id) => !id)
    || orderedIds.length !== expectedIds.length
    || new Set(orderedIds).size !== expectedIds.length
    || orderedIds.some((id) => !expectedIds.includes(id))) {
    throw new Error('The queued messages cannot be reordered.');
  }
  const byId = new Map(current.map((message) => [message.id, message]));
  const reordered = orderedIds.map((id) => byId.get(id)!);
  noteQueueChanged(scope);
  const revision = queueRevisions.get(scope);
  setLocalDraft(scope, { queuedMessages: reordered });
  try {
    const result = await sendQueueRequest(scope, async () => {
      const response = await api.user.reorderQueuedMessages(scope, expectedIds, orderedIds);
      const payload = await response.json().catch(() => null) as { queuedMessages?: unknown; error?: unknown } | null;
      if (!response.ok) throw new ApiRequestError(readApiErrorMessage(payload) ?? `HTTP ${response.status}`, { status: response.status });
      return normalizeQueuedMessages(payload?.queuedMessages);
    });
    if (queueRevisions.get(scope) === revision) setLocalDraft(scope, { queuedMessages: result });
    return result;
  } catch (error) {
    if (queueRevisions.get(scope) === revision) await hydrateChatDrafts();
    throw error;
  }
}

/** Removes one queued turn; omitted ID clears the whole queue for legacy callers. */
export function clearQueuedMessage(scope: string, messageId?: string): void {
  noteQueueChanged(scope);
  setLocalDraft(scope, {
    queuedMessages: messageId
      ? readQueuedMessages(scope).filter((message) => (message.id ?? 'legacy') !== messageId)
      : [],
  });
  void sendQueueRequest(scope, async () => {
    const response = await api.user.clearQueuedMessage(scope, messageId);
    return response.ok;
  }).catch((error: unknown) => {
    console.error('Failed to clear queued chat message:', error);
    return false;
  });
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];
  const queueRevisionsAtRequest = new Map(queueRevisions);

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessages: normalizeQueuedMessages(draft.queuedMessage),
    });
  }

  // Local changes the snapshot cannot contain yet win over it, field by field:
  // text whose debounced write has not left the browser, and a queued message
  // this page changed while the request was in flight. Otherwise the server's
  // queued message wins even for a scope being typed into, which is how this
  // page learns the dispatcher has sent it. Every other missing scope was
  // deleted remotely and must also disappear from the mirror.
  const queueChangedDuringRequest = (scope: string) => (
    (queueRevisions.get(scope) ?? 0) !== (queueRevisionsAtRequest.get(scope) ?? 0)
  );
  const locallyChangedScopes = new Set([
    ...pendingScopes,
    ...[...queueRevisions.keys()].filter(queueChangedDuringRequest),
  ]);
  for (const scope of locallyChangedScopes) {
    const local = drafts.get(scope) ?? EMPTY_DRAFT;
    const server = merged.get(scope) ?? EMPTY_DRAFT;
    const next: DraftRecord = {
      text: pendingScopes.has(scope) ? local.text : server.text,
      queuedMessages: queueChangedDuringRequest(scope) ? local.queuedMessages : server.queuedMessages,
    };
    if (isEmptyDraft(next)) {
      merged.delete(scope);
    } else {
      merged.set(scope, next);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  drafts = new Map();
  pendingScopes.clear();
  queueRevisions.clear();
  queueRequests.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
