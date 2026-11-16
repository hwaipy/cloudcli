import type { ChatMessage, ToolGroupItem } from '@/shared/types';

const TOOL_GROUP_THRESHOLD = 2;

export type MessageListItem = ChatMessage | ToolGroupItem;

/** A run of consecutive tool rows, already narrowed to the ones that can group. */
type GroupableToolRun = (ChatMessage & { toolName: string })[];

type CachedToolGroup = {
  /** The exact run the group was built from; reused only while every row keeps its identity. */
  run: GroupableToolRun;
  /** Hidden reasoning both joins runs and changes what the preview names, so it is part of the key. */
  showThinking: boolean;
  group: ToolGroupItem;
};

// Chat rows keep their identity across a stream tick (useChatMessages' own
// projection cache), but grouping re-runs on every tick over a fresh array.
// Without this cache each collapsed run gets a brand-new group object, so
// `memo(ToolGroupContainer)` cannot bail and every group on screen re-renders
// ~10 times a second while only the streaming row actually changed. Keyed
// weakly on the run's first row so entries disappear with the rows themselves.
const toolGroupCache = new WeakMap<ChatMessage, CachedToolGroup>();

function isSameRun(cachedRun: GroupableToolRun, run: GroupableToolRun): boolean {
  return cachedRun.length === run.length
    && cachedRun.every((message, index) => message === run[index]);
}

/** The group object for a run, reused unchanged while the run's rows are unchanged. */
function getToolGroup(run: GroupableToolRun, showThinking: boolean): ToolGroupItem {
  const first = run[0];
  const cached = toolGroupCache.get(first);
  if (cached && cached.showThinking === showThinking && isSameRun(cached.run, run)) {
    return cached.group;
  }

  const group: ToolGroupItem = {
    _isGroup: true,
    toolName: first.toolName,
    messages: run,
    timestamp: first.timestamp,
    preview: buildGroupPreview(run),
  };
  toolGroupCache.set(first, { run, showThinking, group });
  return group;
}

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

// An agent's or a workflow's row is its whole card — status, timeline, result —
// so it never folds into a collapsed run with its neighbours.
function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(message.isToolUse && message.toolName && !message.isSubagentContainer && !['Workflow', 'AskUserQuestion', 'request_user_input'].includes(message.toolName));
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of tools — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

/** Summarize operations without exposing commands, paths, or tool payloads. */
function buildGroupPreview(messages: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const tool = message.toolName || '';
    const category = ['Edit', 'Write', 'ApplyPatch', 'apply_patch'].includes(tool) ? '修改文件'
      : ['Read', 'read_file'].includes(tool) ? '读取文件'
      : ['Bash', 'exec_command', 'shell_command', 'shell'].includes(tool) ? '运行脚本'
      : ['Grep', 'Glob'].includes(tool) ? '搜索文件'
      : ['WebSearch', 'WebFetch'].includes(tool) ? '访问网络'
      : ['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(tool) ? '管理任务'
      : '其他工具调用';
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return ['修改文件', '读取文件', '运行脚本', '搜索文件', '访问网络', '管理任务', '其他工具调用']
    .filter((category) => counts.has(category))
    .map((category) => `${category} ${counts.get(category)} 次`)
    .join('，');
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: GroupableToolRun = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate)) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= TOOL_GROUP_THRESHOLD) {
      items.push(getToolGroup(run, showThinking));
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
