import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import React, { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@shared/AppShell';
import { youtubeWatchUrl, youtubeWatchUrlAt } from '@shared/format';
import { notifyHostAboutResize } from '@shared/resize';
import {
  parseAvailableSubtitles,
  pickDefaultTrack,
  type AvailableSubtitleTracks,
  type SubtitleTrack,
} from '@shared/subtitleTracks';
import { parseRawSubtitlesResult, parseTimedSubtitles } from '@shared/subtitles';
import { SubtitlesPanel } from '@shared/SubtitlesPanel';
import { styles } from '@shared/styles';
import type { Cue, CuesStatus, VideoMeta } from '@shared/types';
import { VideoCarouselCard } from '@shared/VideoCarouselCard';
import { VideoDetailPanel } from '@shared/VideoDetailPanel';

function parseSearchResults(result: CallToolResult): VideoMeta[] {
  const structured = result.structuredContent as { results?: VideoMeta[] } | undefined;
  if (structured?.results) return structured.results;

  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { results?: VideoMeta[] };
    return parsed.results ?? [];
  } catch {
    return [];
  }
}

function SearchApp() {
  const [results, setResults] = useState<VideoMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesStatus, setCuesStatus] = useState<CuesStatus>('idle');
  const [availableTracks, setAvailableTracks] = useState<AvailableSubtitleTracks | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<SubtitleTrack | null>(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [status, setStatus] = useState<'waiting' | 'ready' | 'empty'>('waiting');
  const [appRef, setAppRef] = useState<App | null>(null);
  const cuesStatusRef = useRef(cuesStatus);
  cuesStatusRef.current = cuesStatus;

  const { isConnected, error } = useApp({
    appInfo: { name: 'SearchVideos', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      setAppRef(app);
      app.ontoolresult = (result) => {
        const parsed = parseSearchResults(result);
        setResults(parsed);
        setSelectedId(null);
        setCues([]);
        setCuesStatus('idle');
        setAvailableTracks(null);
        setSelectedTrack(null);
        setStatus(parsed.length === 0 ? 'empty' : 'ready');
      };
    },
  });

  useHostStyles(appRef);

  const handleOpenExternal = useCallback(
    async (video: VideoMeta, seconds?: number) => {
      const url = seconds != null ? youtubeWatchUrlAt(video, seconds) : youtubeWatchUrl(video);
      if (appRef) {
        await appRef.openLink({ url });
      } else {
        globalThis.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [appRef]
  );

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setCues([]);
    setCuesStatus('idle');
    setAvailableTracks(null);
    setSelectedTrack(null);
    notifyHostAboutResize();
  }, []);

  const handleCardClick = useCallback((video: VideoMeta) => {
    setSelectedId((prev) => {
      const next = prev === video.videoId ? null : video.videoId;
      if (next !== prev) {
        setCues([]);
        setCuesStatus('idle');
        setAvailableTracks(null);
        setSelectedTrack(null);
      }
      return next;
    });
    notifyHostAboutResize();
  }, []);

  const loadSubtitles = useCallback(
    async (track?: SubtitleTrack | null) => {
      if (!selectedId || !appRef || cuesStatusRef.current === 'loading') return;

      const videoId = selectedId;
      const t = track ?? selectedTrack;
      setCuesStatus('loading');
      setCues([]);

      try {
        const result = await appRef.callServerTool({
          name: 'get_raw_subtitles',
          arguments: {
            url: videoId,
            format: 'srt',
            ...(t ? { type: t.type, lang: t.lang } : {}),
          },
        });

        if (result.isError) {
          setCuesStatus('error');
          notifyHostAboutResize();
          return;
        }

        const raw = parseRawSubtitlesResult(result);
        if (!raw?.trim()) {
          setCuesStatus('empty');
          notifyHostAboutResize();
          return;
        }

        const parsed = parseTimedSubtitles(raw);
        if (parsed.length === 0) {
          setCuesStatus('empty');
        } else {
          setCues(parsed);
          setCuesStatus('ready');
        }
        notifyHostAboutResize();
      } catch {
        setCuesStatus('error');
        notifyHostAboutResize();
      }
    },
    [selectedId, appRef, selectedTrack]
  );

  const handleTrackSelect = useCallback(
    (track: SubtitleTrack) => {
      setSelectedTrack(track);
      if (cuesStatusRef.current === 'ready') {
        void loadSubtitles(track);
      }
    },
    [loadSubtitles]
  );

  useEffect(() => {
    if (!selectedId || !appRef) {
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
          arguments: { url: selectedId },
        });
        if (cancelled) return;

        const tracks = result.isError ? null : parseAvailableSubtitles(result);
        setAvailableTracks(tracks);
        setSelectedTrack(tracks ? pickDefaultTrack(tracks) : null);
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
  }, [selectedId, appRef]);

  useEffect(() => {
    notifyHostAboutResize();
  }, [selectedId, results.length, status, cuesStatus, cues.length, tracksLoading]);

  if (error) {
    return <div style={styles.centered}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={styles.centered}>Connecting…</div>;
  }

  const selected = results.find((r) => r.videoId === selectedId);

  return (
    <AppShell title="Search results">
      {selected && (
        <VideoDetailPanel
          video={selected}
          onOpen={() => void handleOpenExternal(selected)}
          onClose={closeDetail}
        >
          <SubtitlesPanel
            cues={cues}
            status={cuesStatus}
            video={selected}
            onOpenAtTime={(seconds) => void handleOpenExternal(selected, seconds)}
            onLoadSubtitles={() => void loadSubtitles()}
            availableTracks={availableTracks}
            selectedTrack={selectedTrack}
            onTrackSelect={handleTrackSelect}
            tracksLoading={tracksLoading}
          />
        </VideoDetailPanel>
      )}

      {status === 'waiting' && <div style={styles.centered}>Waiting for search results…</div>}
      {status === 'empty' && <div style={styles.centered}>No results found.</div>}

      {results.length > 0 && (
        <ul style={styles.carousel}>
          {results.map((video) => (
            <VideoCarouselCard
              key={video.videoId}
              video={video}
              isActive={video.videoId === selectedId}
              onClick={() => handleCardClick(video)}
            />
          ))}
        </ul>
      )}
    </AppShell>
  );
}

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <SearchApp />
    </StrictMode>
  );
}
