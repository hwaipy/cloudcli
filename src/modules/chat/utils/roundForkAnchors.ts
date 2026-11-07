import type { ChatMessage } from '@/shared/types';

// Reuse completed answer projections while later streaming rows change.
const forkProjectionCache = new WeakMap<ChatMessage, ChatMessage>();

/** ChatMessagesPane uses this to expose a fork only on the last answer of a completed round. */
export function withRoundForkAnchors(messages: ChatMessage[], provider: string, running: boolean): ChatMessage[] {
  const anchors = new Map<ChatMessage, string>();
  let userAnchor: string | undefined;
  let answer: ChatMessage | undefined;
  const finish = () => {
    const anchor = provider === 'codex' ? userAnchor : answer?.transcriptAnchorId;
    if (answer && anchor) anchors.set(answer, anchor);
    answer = undefined;
  };
  for (const message of messages) {
    if (message.type === 'user') {
      // Unanchored Codex inputs can be Steer messages in the current turn.
      // Keep the turn's anchor until its final answer, without guessing a new one.
      if (provider !== 'codex' || message.transcriptAnchorId || answer) {
        finish();
        userAnchor = message.transcriptAnchorId;
      }
      continue;
    }
    if (message.type === 'assistant' && !message.isThinking && !message.isToolUse
      && !message.isStreaming && !message.toolId && !message.compact
      && (provider === 'codex' || Boolean(message.transcriptAnchorId)) && message.content?.trim()
      && (provider !== 'codex' || message.codexPhase === 'final_answer' || !message.codexPhase)) {
      answer = message;
    }
  }
  if (!running) finish();
  return messages.map(message => {
    const anchor = anchors.get(message);
    if (!anchor) return message;
    const cached = forkProjectionCache.get(message);
    if (cached?.forkAnchorId === anchor) return cached;
    const projected = { ...message, forkAnchorId: anchor };
    forkProjectionCache.set(message, projected);
    return projected;
  });
}
