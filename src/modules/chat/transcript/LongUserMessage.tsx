import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon } from 'lucide-react';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';

type MessagePart = { kind: 'code' | 'text'; content: string };

function splitFencedCode(content: string): MessagePart[] {
  const lines = content.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const parts: MessagePart[] = [];
  let textStart = 0;
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.exec(lines[index]);
    if (!opening) continue;
    const marker = opening[1];
    let closingIndex = index + 1;
    for (; closingIndex < lines.length; closingIndex++) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[closingIndex]);
      if (closing?.[1][0] === marker[0] && closing[1].length >= marker.length) break;
    }
    if (closingIndex === lines.length) continue;

    const codeStart = starts[index];
    const codeEnd = starts[closingIndex] + lines[closingIndex].length;
    if (codeStart > textStart) parts.push({ kind: 'text', content: content.slice(textStart, codeStart) });
    parts.push({ kind: 'code', content: content.slice(codeStart, codeEnd) });
    textStart = codeEnd;
    index = closingIndex;
  }
  if (textStart < content.length) parts.push({ kind: 'text', content: content.slice(textStart) });
  return parts.length > 0 ? parts : [{ kind: 'text', content }];
}

function isLongPart(part: MessagePart): boolean {
  const lineCount = part.content.split('\n').length;
  return part.kind === 'code'
    ? lineCount > 14 || part.content.length > 900
    : lineCount > 24 || part.content.length > 1800;
}

function UserMessagePart({ part, collapsedByDefault }: { part: MessagePart; collapsedByDefault: boolean }) {
  const { t } = useTranslation('chat');
  const isExporting = useIsExportingTranscript();
  // Each long block owns its toggle so opening a code sample does not expand
  // unrelated Markdown elsewhere in the same user message.
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsedByDefault && !expanded && !isExporting;
  const toggleLabel = part.kind === 'code'
    ? expanded ? t('message.collapseCode', '收起代码') : t('message.expandCode', '展开代码')
    : expanded ? t('message.collapseContent', '收起内容') : t('message.expandContent', '展开内容');

  return (
    <div className="min-w-0">
      <div className={`relative ${collapsed ? 'max-h-52 overflow-hidden' : ''}`}>
        <Markdown breaks className="prose prose-sm max-w-none font-serif dark:prose-invert">
          {part.content}
        </Markdown>
        {collapsed && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted to-transparent" />}
      </div>
      {collapsedByDefault && !isExporting && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {toggleLabel}
        </button>
      )}
    </div>
  );
}

/** Used by MessageComponent to keep long user input compact without hiding nearby context. */
export function LongUserMessage({ content }: { content: string }) {
  const parts = useMemo(() => {
    const segments = splitFencedCode(content);
    // A long document made of many short blocks still needs a compact view.
    return content.length > 3000 && !segments.some(isLongPart)
      ? [{ kind: 'text' as const, content }]
      : segments;
  }, [content]);

  return (
    <div dir="auto" className="min-w-0 break-words font-serif text-sm">
      {parts.map((part, index) => (
        <UserMessagePart key={`${index}-${part.kind}`} part={part} collapsedByDefault={isLongPart(part)} />
      ))}
    </div>
  );
}
