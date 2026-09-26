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

/** `en`, `en-US`, `en_US`, `en-x-autogen`, `en-orig`: all `en`. */
const baseLang = (lang: string): string => lang.split(/[-_]/)[0].toLowerCase();

/**
 * The server's rule (pickOriginalTrack in src/validation.ts), as far as the track list shows
 * it: a lone `-orig` track names the language the video is spoken in, and an official track in
 * that language comes first. The language the platform reports, which settles several `-orig`
 * tracks on a dubbed video, never reaches the widget. Elsewhere a person still gets a track to
 * look at, English first, and has the picker for the rest.
 */
export function pickDefaultTrack(
  available: AvailableSubtitleTracks,
  preferred?: SubtitleTrack | null
): SubtitleTrack | null {
  if (preferred && trackMatches(available, preferred)) return preferred;
  const { official, auto } = available;
  const origs = auto.filter((lang) => lang.endsWith('-orig'));
  const orig = new Set(origs.map(baseLang)).size === 1 ? origs[0] : undefined;
  if (orig) {
    const same = official.find((lang) => baseLang(lang) === baseLang(orig));
    return same ? { type: 'official', lang: same } : { type: 'auto', lang: orig };
  }
  const english = (lang: string): boolean => baseLang(lang) === 'en';
  const firstOfficial = official.find(english) ?? official[0];
  if (firstOfficial) return { type: 'official', lang: firstOfficial };
  // -orig first, as the server ranks: on YouTube a plain code also gathers translations into
  // that language from every dubbed audio track, and the -orig one is the speech itself.
  const ranked = sortAutoLanguages(auto);
  const firstAuto = ranked.find(english) ?? ranked[0];
  if (firstAuto) return { type: 'auto', lang: firstAuto };
  // No tracks, yet a transcript with a language: speech-to-text, asked for by name.
  // Asking again by the same name reads its cache entry instead of transcribing again.
  return preferred?.lang ? preferred : null;
}

export function hasAvailableTracks(tracks: AvailableSubtitleTracks | null): boolean {
  if (!tracks) return false;
  return tracks.official.length > 0 || tracks.auto.length > 0;
}

export function tracksEqual(a: SubtitleTrack | null, b: SubtitleTrack | null): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.lang === b.lang;
}
