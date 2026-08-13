export type AIInlineSegment = {
  readonly kind: 'text' | 'code' | 'strong' | 'emphasis';
  readonly text: string;
};

export type AITextBlock =
  | {
      readonly kind: 'heading';
      readonly level: number;
      readonly segments: readonly AIInlineSegment[];
    }
  | {
      readonly kind: 'list_item';
      readonly ordered: boolean;
      readonly ordinal: number | null;
      readonly segments: readonly AIInlineSegment[];
    }
  | {
      readonly kind: 'paragraph';
      readonly segments: readonly AIInlineSegment[];
    }
  | {
      readonly kind: 'code_block';
      readonly language: string;
      readonly code: string;
    };

const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

export function parseAIInlineText(value: string): readonly AIInlineSegment[] {
  const segments: AIInlineSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ kind: 'text', text: value.slice(cursor, index) });
    }
    const token = match[0];
    if (token.startsWith('`')) {
      segments.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      segments.push({ kind: 'strong', text: token.slice(2, -2) });
    } else {
      segments.push({ kind: 'emphasis', text: token.slice(1, -1) });
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) {
    segments.push({ kind: 'text', text: value.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text: value }];
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  );
}

/**
 * Small allowlist parser. HTML, links, images, directives, and every unknown
 * syntax remain inert text; no output variant contains a URL or callback.
 */
export function parseConstrainedAIText(content: string): readonly AITextBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AITextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence !== null) {
      const language = fence[1].trim().slice(0, 40);
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        kind: 'code_block',
        language,
        code: codeLines.join('\n'),
      });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        segments: parseAIInlineText(heading[2]),
      });
      index += 1;
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unordered !== null) {
      blocks.push({
        kind: 'list_item',
        ordered: false,
        ordinal: null,
        segments: parseAIInlineText(unordered[1]),
      });
      index += 1;
      continue;
    }

    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (ordered !== null) {
      const parsedOrdinal = Number(ordered[1]);
      blocks.push({
        kind: 'list_item',
        ordered: true,
        ordinal: Number.isSafeInteger(parsedOrdinal) ? parsedOrdinal : 1,
        segments: parseAIInlineText(ordered[2]),
      });
      index += 1;
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({
      kind: 'paragraph',
      segments: parseAIInlineText(paragraphLines.join('\n')),
    });
  }
  return blocks;
}
