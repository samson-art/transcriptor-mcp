import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Cue } from './types.js';

const TIMESTAMP_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export function parseTimestampToSeconds(timestamp: string): number | null {
  const match = TIMESTAMP_RE.exec(timestamp.trim());
  if (!match) return null;
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const s = Number.parseInt(match[3], 10);
  const ms = Number.parseInt(match[4].padEnd(3, '0'), 10);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s) || Number.isNaN(ms)) return null;
  return Math.floor(h * 3600 + m * 60 + s + ms / 1000);
}

function stripVttInlineTags(text: string): string {
  return text.replaceAll(/<[^>]+>/g, '').trim();
}

export function parseTimedSubtitles(raw: string): Cue[] {
  const lines = raw.replaceAll('\r\n', '\n').split('\n');
  const cues: Cue[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      i += 1;
      continue;
    }

    if (/^\d+$/.test(line)) {
      i += 1;
      if (i >= lines.length) break;
    }

    const timingLine = lines[i].trim();
    const arrowIdx = timingLine.indexOf('-->');
    if (arrowIdx === -1) {
      i += 1;
      continue;
    }

    const startPart = timingLine.slice(0, arrowIdx).trim();
    const start = parseTimestampToSeconds(startPart);
    i += 1;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(stripVttInlineTags(lines[i]));
      i += 1;
    }

    const text = textLines.join(' ').trim();
    if (start != null && text) {
      cues.push({ start, text });
    }
    i += 1;
  }

  return cues;
}

export function parseRawSubtitlesResult(result: CallToolResult): string | null {
  const structured = result.structuredContent as { content?: string } | undefined;
  if (typeof structured?.content === 'string') return structured.content;

  const text = result.content?.find((c) => c.type === 'text')?.text;
  return text ?? null;
}

export type RawSubtitlesPage = {
  content: string;
  nextCursor?: string;
  isTruncated: boolean;
};

export function parseRawSubtitlesPage(result: CallToolResult): RawSubtitlesPage | null {
  const structured = result.structuredContent as
    | {
        content?: string;
        next_cursor?: string;
        is_truncated?: boolean;
      }
    | undefined;
  if (typeof structured?.content !== 'string') return null;
  return {
    content: structured.content,
    nextCursor: structured.next_cursor,
    isTruncated: structured.is_truncated ?? false,
  };
}
