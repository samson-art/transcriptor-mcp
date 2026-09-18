import type { VideoMeta } from './types.js';

/** Empty when the platform does not report a length (Instagram), so no lone dash is shown. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatViews(count: number | null): string {
  if (count == null) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count} views`;
}

export function formatCueTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * A YouTube id's page. Only for an id known to be YouTube: a search result (the search
 * is YouTube-only), or a bare id the server itself resolved as one.
 */
export function youtubeWatchUrl(video: Pick<VideoMeta, 'videoId' | 'url'>): string {
  return video.url ?? `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
}

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be)$/;

export function isYouTubePage(url: string): boolean {
  try {
    return YOUTUBE_HOST.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** What the model passed as `url`, as a page: the server reads a bare id as a YouTube id. */
export function pageFromInput(input: string): string {
  return /^https?:\/\//i.test(input) ? input : youtubeWatchUrl({ videoId: input, url: null });
}

/** Instagram and TikTok have no link to a moment: a cue there opens the page from the start. */
export function watchUrlAt(url: string, seconds: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const t = Math.max(0, Math.floor(seconds));
  // ponytail: Twitch (?t=1h2m3s), Bilibili (?t=) and Dailymotion (?start=) have one too; a line each when asked for.
  if (YOUTUBE_HOST.test(parsed.hostname)) parsed.searchParams.set('t', String(t));
  else if (/(^|\.)vimeo\.com$/.test(parsed.hostname)) parsed.hash = `t=${t}s`;
  else return url;
  return parsed.toString();
}
