import type { Nodes, Root, PhrasingContent } from 'mdast';

// Parse attributes rather than evaluating them. Partial or malformed streaming directives stay literal.
function citationPath(attributes: string): string | null {
  const values = new Map<string, string>();
  let rest = attributes.trim();
  while (rest) {
    const match = /^([a-zA-Z][\w-]*)="((?:\\.|[^"\\])*)"(?:\s+|$)/.exec(rest);
    if (!match || values.has(match[1])) return null;
    let value: string;
    try { value = JSON.parse(`"${match[2]}"`); } catch { return null; }
    values.set(match[1], value);
    rest = rest.slice(match[0].length);
  }
  const path = values.get('path');
  if (!path || !path.trim() || /[\u0000-\u001f]/.test(path)) return null;
  // File references cannot turn into web links, script URLs or network shares.
  if ((/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) || /^(\/\/|\\\\)/.test(path)) return null;
  return path;
}

/** Used by chat's Markdown renderer to open Codex output-file directives through the existing workspace file actions. */
export function remarkCodexFileCitations() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    // Read the raw source so brackets, backticks and underscores inside a path
    // cannot be consumed as Markdown syntax before the directive is recognized.
    const citations = [...source.matchAll(/:codex-file-citation\{((?:"(?:\\.|[^"\\])*"|[^"{}])*)\}/g)]
      .map((match) => ({ start: match.index, end: match.index + match[0].length, path: citationPath(match[1]) }))
      .filter((match) => match.path !== null);
    function visit(node: Nodes): void {
      if (['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference'].includes(node.type) || !('children' in node)) return;
      const children = node.children as Nodes[];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.type !== 'text') { visit(child); continue; }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        const match = citations.find((candidate) => candidate.start >= start && candidate.start < end);
        if (!match || !match.path) continue;
        let lastIndex = index;
        while (lastIndex < children.length && (children[lastIndex].position?.end.offset ?? -1) < match.end) lastIndex += 1;
        const last = children[lastIndex];
        if (last?.type !== 'text' || (last.position?.end.offset ?? -1) < match.end) continue;
        const pieces: PhrasingContent[] = [];
        if (match.start > start) pieces.push({ type: 'text', value: source.slice(start, match.start) });
        pieces.push({
          type: 'link', url: match.path, title: match.path,
          data: { hProperties: { 'data-codex-file-path': match.path } },
          children: [{ type: 'text', value: match.path.split(/[\\/]/).filter(Boolean).at(-1) || match.path }],
        });
        const lastEnd = last.position!.end.offset!;
        if (match.end < lastEnd) pieces.push({
          type: 'text', value: source.slice(match.end, lastEnd),
          position: { start: { line: 1, column: 1, offset: match.end }, end: last.position!.end },
        });
        children.splice(index, lastIndex - index + 1, ...pieces);
        // Revisit the trailing text in case the same paragraph contains another citation.
        index += pieces.length - (match.end < lastEnd ? 2 : 1);
      }
    }
    visit(tree);
  };
}
