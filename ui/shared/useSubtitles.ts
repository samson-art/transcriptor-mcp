import type { App } from '@modelcontextprotocol/ext-apps';
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyHostAboutResize } from './resize.js';
import {
  parseAvailableSubtitles,
  pickDefaultTrack,
  type AvailableSubtitleTracks,
  type SubtitleTrack,
} from './subtitleTracks.js';
import {
  parseRawSubtitlesPage,
  parseRawSubtitlesResult,
  parseTimedSubtitles,
} from './subtitles.js';
import type { Cue, CuesStatus } from './types.js';

type PreferredTrack = Pick<SubtitleTrack, 'type' | 'lang'>;

type UseSubtitlesOptions = {
  preferredTrack?: PreferredTrack | null;
};

export function useSubtitles(
  appRef: App | null,
  videoId: string | null | undefined,
  options?: UseSubtitlesOptions
) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesStatus, setCuesStatus] = useState<CuesStatus>('idle');
  const [availableTracks, setAvailableTracks] = useState<AvailableSubtitleTracks | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<SubtitleTrack | null>(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [isTruncated, setIsTruncated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const cuesStatusRef = useRef(cuesStatus);
  const selectedTrackRef = useRef(selectedTrack);
  const preferredTrackRef = useRef<PreferredTrack | null>(options?.preferredTrack ?? null);
  cuesStatusRef.current = cuesStatus;
  selectedTrackRef.current = selectedTrack;

  useEffect(() => {
    if (options?.preferredTrack) {
      preferredTrackRef.current = options.preferredTrack;
    }
  }, [options?.preferredTrack]);

  const reset = useCallback(() => {
    setCues([]);
    setCuesStatus('idle');
    setAvailableTracks(null);
    setSelectedTrack(null);
    setNextCursor(undefined);
    setIsTruncated(false);
    setLoadingMore(false);
  }, []);

  const loadSubtitles = useCallback(
    async (cursor?: string, append = false, track?: SubtitleTrack | null) => {
      if (!videoId || !appRef || (!append && cuesStatusRef.current === 'loading')) return;

      const t = track ?? selectedTrackRef.current;

      if (!append) {
        setCuesStatus('loading');
        setCues([]);
        setNextCursor(undefined);
        setIsTruncated(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const result = await appRef.callServerTool({
          name: 'get_raw_subtitles',
          arguments: {
            url: videoId,
            format: 'srt',
            ...(t ? { type: t.type, lang: t.lang } : {}),
            ...(cursor ? { next_cursor: cursor } : {}),
          },
        });

        if (result.isError) {
          if (!append) setCuesStatus('error');
          return;
        }

        const page = parseRawSubtitlesPage(result);
        const raw = page?.content ?? parseRawSubtitlesResult(result);
        if (!raw?.trim()) {
          if (!append) setCuesStatus('empty');
          return;
        }

        const parsed = parseTimedSubtitles(raw);
        if (append) {
          setCues((prev) => [...prev, ...parsed]);
        } else if (parsed.length === 0) {
          setCuesStatus('empty');
        } else {
          setCues(parsed);
          setCuesStatus('ready');
        }

        if (page) {
          setNextCursor(page.nextCursor);
          setIsTruncated(page.isTruncated);
        }
      } catch {
        if (!append) setCuesStatus('error');
      } finally {
        setLoadingMore(false);
        notifyHostAboutResize();
      }
    },
    [appRef, videoId]
  );

  useEffect(() => {
    if (!videoId || !appRef) {
      setAvailableTracks(null);
      setSelectedTrack(null);
      setTracksLoading(false);
      return;
    }

    let cancelled = false;
    setTracksLoading(true);

    void (async () => {
      try {
        const result = await appRef.callServerTool({
          name: 'get_available_subtitles',
          arguments: { url: videoId },
        });
        if (cancelled) return;

        const tracks = result.isError ? null : parseAvailableSubtitles(result);
        const preferred = preferredTrackRef.current;
        preferredTrackRef.current = null;
        setAvailableTracks(tracks);
        setSelectedTrack(tracks ? pickDefaultTrack(tracks, preferred) : null);
      } catch {
        if (!cancelled) {
          setAvailableTracks(null);
          setSelectedTrack(null);
        }
      } finally {
        if (!cancelled) {
          setTracksLoading(false);
          notifyHostAboutResize();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [videoId, appRef]);

  const handleLoadSubtitles = useCallback(() => {
    void loadSubtitles();
  }, [loadSubtitles]);

  const handleTrackSelect = useCallback(
    (track: SubtitleTrack) => {
      setSelectedTrack(track);
      if (cuesStatusRef.current === 'ready') {
        void loadSubtitles(undefined, false, track);
      }
    },
    [loadSubtitles]
  );

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    void loadSubtitles(nextCursor, true);
  }, [nextCursor, loadingMore, loadSubtitles]);

  return {
    cues,
    cuesStatus,
    availableTracks,
    selectedTrack,
    tracksLoading,
    nextCursor,
    isTruncated,
    loadingMore,
    loadSubtitles: handleLoadSubtitles,
    handleTrackSelect,
    handleLoadMore,
    reset,
  };
}
