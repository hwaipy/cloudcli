import type { NormalizedMessage } from '@/shared/types';
import { isStorableChatMessage } from '@/shared/utils';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;
// App Server can write accepted Steer input near the end of a long turn. Its
// runtime caps a turn at 30 minutes; keep this separate from ordinary sends.
const STEER_USER_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  // The echo of an edited message may only be retired by a row that was not
  // in the transcript when the cut was made. Text and a time window are not
  // enough for it: a rewind that branches re-stamps every surviving turn to
  // the moment of the copy, so an earlier turn with the same words — "yes",
  // "continue", the typo being corrected — lands inside the window and would
  // retire the message the user just sent.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  const dedupeWindow = localFingerprint.text
    ? localMessage.id.startsWith('steer_')
      ? STEER_USER_DEDUPE_WINDOW_MS
      : LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (
      claimedServerIds.has(serverMessage.id)
      || serverMessage.sessionId !== localMessage.sessionId
      || serverMessage.provider !== localMessage.provider
    ) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Removes local optimistic and Codex Steer user rows once a corresponding
 * persisted turn is available. Matches are one-to-one so repeated sends
 * cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    if (!isStorableChatMessage(message)) return false;
    const isLocalEcho = message.id.startsWith('local_');
    const isCodexSteerEcho = message.id.startsWith('steer_')
      && message.provider === 'codex'
      && message.kind === 'text'
      && message.role === 'user';
    if (!isLocalEcho && !isCodexSteerEcho) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}
