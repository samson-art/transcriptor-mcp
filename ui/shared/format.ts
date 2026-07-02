import type { VideoMeta } from './types.js';

export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return '—';
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

export function youtubeWatchUrl(video: Pick<VideoMeta, 'videoId' | 'url'>): string {
  return video.url ?? `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
}

export function youtubeWatchUrlAt(video: Pick<VideoMeta, 'videoId' | 'url'>, seconds: number): string {
  const base = youtubeWatchUrl(video);
  const url = new URL(base);
  url.searchParams.set('t', String(Math.floor(seconds)));
  return url.toString();
}
