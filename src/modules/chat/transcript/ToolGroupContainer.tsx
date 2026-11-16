import { memo, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, LLMProvider,DiffLine,DiffStats,Project,ToolGroupItem } from '@/shared/types';
import { getToolConfig } from '@/modules/chat/tools';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';

type ToolGroupContainerProps = {
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
};

/**
 * Totals the lines a run of file edits added and removed.
 *
 * A collapsed group hides every individual diff behind `x4`, so without this
 * the one thing the row could usefully say about a batch of edits — how big it
 * is — is the one thing it did not. Returns null for groups of tools that do
 * not render a diff at all.
 */
function useGroupDiffStats(
  messages: ChatMessage[],
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
): DiffStats | null {
  return useMemo(() => {
    let added = 0;
    let removed = 0;
    let counted = 0;

    for (const message of messages) {
      const config = getToolConfig(message.toolName || "UnknownTool").input;
      if (config.contentType !== "diff" || !config.getContentProps) continue;
      const contentProps = config.getContentProps(parseToolPayload(message.toolInput) ?? {});
      if (typeof contentProps?.oldContent !== 'string' || typeof contentProps?.newContent !== 'string') {
        continue;
      }

      const stats = summarizeDiff(createDiff(contentProps.oldContent, contentProps.newContent));
      added += stats.added;
      removed += stats.removed;
      counted += 1;
    }

    return counted > 0 ? { added, removed } : null;
  }, [createDiff, messages]);
}

function getToolGroupIcon(icon: string | undefined, toolName: string): string {
  if (icon === 'terminal') {
    return '$';
  }

  return icon || toolName.slice(0, 1).toUpperCase();
}

/** Each call stays one line until explicitly opened, independently of its tool defaults. */
function GroupedToolCall(props: React.ComponentProps<typeof MessageComponent>) {
  // Opening a group must never implicitly open its individual calls.
  const [expanded, setExpanded] = useState(false);
  const exporting = useIsExportingTranscript();
  const { message } = props;
  const config = getToolConfig(message.toolName || 'UnknownTool').input;
  const input = parseToolPayload(message.toolInput) ?? {};
  const preview = String(config.getValue?.(input) || (typeof config.title === 'function' ? config.title(input) : config.title) || '');
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={expanded || exporting}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40">
        <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded || exporting ? 'rotate-90' : ''}`} />
        <span className="shrink-0 font-medium">{config.label || message.toolName}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{preview}</span>
        {message.toolResult?.isError && <span className="ml-auto shrink-0 text-destructive">错误</span>}
        {message.toolStatus === 'in_progress' && <span className="ml-auto shrink-0 text-muted-foreground">运行中</span>}
      </button>
      {(expanded || exporting) && <MessageComponent {...props} expandToolDetails />}
    </div>
  );
}

/**
 * Rendered by chat's ChatMessagesPane and completed Codex updates to collapse a run of consecutive tool
 * calls into a single expandable group in the transcript.
 */
function ToolGroupContainer({
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: ToolGroupContainerProps) {
  const isExporting = useIsExportingTranscript();
  // Collapsed on screen, always open in an export: the whole point of the
  // group row is to hide detail the reader can ask for, and an exported file
  // has no way to ask.
  const [isExpanded, setIsExpanded] = useState(false);
  const showChildren = isExpanded || isExporting;
  const config = getToolConfig(group.toolName).input;
  const borderClass = config.colorScheme?.border || 'border-border';
  const iconClass = config.colorScheme?.icon || 'text-muted-foreground';
  const icon = getToolGroupIcon(config.icon, group.toolName);

  const preview = group.preview;
  const groupDiffStats = useGroupDiffStats(group.messages, createDiff);

  // Keys only have to be unique among this group's own rows, so repeats of the
  // same key are disambiguated here by occurrence.
  const messageKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return group.messages.map((message) => {
      const key = getMessageKey(message);
      const seen = occurrences.get(key) ?? 0;
      occurrences.set(key, seen + 1);
      return seen === 0 ? key : `${key}__${seen}`;
    });
  }, [group.messages, getMessageKey]);

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={group.timestamp || undefined}>
      <button
        type="button"
        className={`group flex w-full items-center gap-2 border-l-2 ${borderClass} rounded-r-md bg-muted/25 px-3 py-2 text-left transition-colors hover:bg-muted/40 dark:bg-muted/10 dark:hover:bg-muted/20`}
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={showChildren}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className={`${iconClass} flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-background/80 text-xs font-medium`}>
          {icon}
        </span>
        <span className="min-w-0 text-xs text-muted-foreground" aria-label={`工具调用：${preview}`}>
          {preview}
        </span>
        {groupDiffStats && <DiffStatsBadge stats={groupDiffStats} className="ml-auto pl-2" />}
      </button>

      {showChildren && (
        <div className="mt-2 space-y-3 sm:space-y-4">
          {group.messages.map((message, index) => (
            <GroupedToolCall
              key={messageKeys[index]}
              message={message}
              prevMessage={index > 0 ? group.messages[index - 1] : prevMessage}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              provider={provider}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized for the transcript re-renders that are not message changes — the
 * pane re-renders when isProcessing or the activity indicator flips, and on
 * every 100ms stream tick, and the group is unchanged then.
 *
 * Bailing out depends on two identities the pane keeps stable on its side:
 * `group`, which groupConsecutiveTools reuses while the run's rows are
 * unchanged, and `getMessageKey`, a module-level function. Adding a prop
 * rebuilt per render here would cost every group on screen a render per tick.
 */
export default memo(ToolGroupContainer);
