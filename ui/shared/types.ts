export type VideoMeta = {
  videoId: string;
  title: string | null;
  url: string | null;
  duration: number | null;
  uploader: string | null;
  viewCount: number | null;
  thumbnail: string | null;
};

export type Cue = {
  start: number;
  text: string;
};

export type CuesStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export type { SubtitleTrack, AvailableSubtitleTracks } from './subtitleTracks.js';
