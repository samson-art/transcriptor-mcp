import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type SubtitleTrack = { type: 'official' | 'auto'; lang: string };

export type AvailableSubtitleTracks = {
  official: string[];
  auto: string[];
};

export function parseAvailableSubtitles(result: CallToolResult): AvailableSubtitleTracks | null {
  const structured = result.structuredContent as
    | { official?: string[]; auto?: string[] }
    | undefined;
  if (structured && Array.isArray(structured.official) && Array.isArray(structured.auto)) {
    return { official: structured.official, auto: structured.auto };
  }

  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { official?: string[]; auto?: string[] };
    if (Array.isArray(parsed.official) && Array.isArray(parsed.auto)) {
      return { official: parsed.official, auto: parsed.auto };
    }
    return null;
  } catch {
    return null;
  }
}

export function trackMatches(
  available: AvailableSubtitleTracks,
  track: SubtitleTrack
): boolean {
  return track.type === 'official'
    ? available.official.includes(track.lang)
    : available.auto.includes(track.lang);
}

export function sortAutoLanguages(langs: string[]): string[] {
  return [...langs].sort((a, b) => {
    const aOrig = a.endsWith('-orig');
    const bOrig = b.endsWith('-orig');
    if (aOrig !== bOrig) return aOrig ? -1 : 1;
    return a.localeCompare(b);
  });
}

export function pickDefaultTrack(
  available: AvailableSubtitleTracks,
  preferred?: SubtitleTrack | null
): SubtitleTrack | null {
  if (preferred && trackMatches(available, preferred)) return preferred;
  const firstOfficial = available.official[0];
  if (firstOfficial) return { type: 'official', lang: firstOfficial };
  const firstAuto = sortAutoLanguages(available.auto)[0];
  if (firstAuto) return { type: 'auto', lang: firstAuto };
  return null;
}

export function hasAvailableTracks(tracks: AvailableSubtitleTracks | null): boolean {
  if (!tracks) return false;
  return tracks.official.length > 0 || tracks.auto.length > 0;
}

export function tracksEqual(a: SubtitleTrack | null, b: SubtitleTrack | null): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.lang === b.lang;
}
