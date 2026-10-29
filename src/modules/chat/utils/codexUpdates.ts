import type { ChatMessage } from '@/shared/types';

/** Used by ChatMessagesPane to fold one Codex turn's progress notes when its final answer arrives. */
export function foldCodexUpdates(messages: ChatMessage[], provider: string): ChatMessage[] {
  if (provider !== 'codex') return messages;

  const result: ChatMessage[] = [];
  let turnStart = 0;
  let userTimestamp: ChatMessage['timestamp'] | undefined;

  for (const message of messages) {
    if (message.type === 'user') {
      result.push(message);
      turnStart = result.length;
      userTimestamp = message.timestamp;
      continue;
    }

    if (message.type === 'assistant' && message.codexPhase === 'final_answer') {
      const updateIndices: number[] = [];
      for (let index = turnStart; index < result.length; index += 1) {
        const candidate = result[index];
        if (candidate.type === 'assistant' && !candidate.codexUpdates &&
          (candidate.codexPhase === 'commentary' || candidate.isToolUse || candidate.isThinking)) {
          updateIndices.push(index);
        }
      }

      if (updateIndices.length > 0) {
        const updates = updateIndices.map((index) => result[index]);
        const firstIndex = updateIndices[0];
        const startedAt = new Date(userTimestamp ?? updates[0].timestamp).getTime();
        const finishedAt = new Date(message.timestamp).getTime();
        result[firstIndex] = {
          type: 'assistant',
          content: '',
          timestamp: updates[0].timestamp,
          codexUpdates: updates,
          codexWorkDurationMs: Number.isFinite(startedAt) && Number.isFinite(finishedAt)
            ? Math.max(0, finishedAt - startedAt)
            : undefined,
        };
        for (let index = updateIndices.length - 1; index > 0; index -= 1) {
          result.splice(updateIndices[index], 1);
        }
      }

      result.push(message);
      turnStart = result.length;
      userTimestamp = undefined;
      continue;
    }

    result.push(message);
  }

  return result;
}
