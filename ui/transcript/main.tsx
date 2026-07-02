import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import React, { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@shared/AppShell';
import { youtubeWatchUrl, youtubeWatchUrlAt } from '@shared/format';
import { notifyHostAboutResize } from '@shared/resize';
import type { SubtitleTrack } from '@shared/subtitleTracks';
import { SubtitlesPanel } from '@shared/SubtitlesPanel';
import { styles } from '@shared/styles';
import type { VideoMeta } from '@shared/types';
import { useSubtitles } from '@shared/useSubtitles';
import { VideoDetailPanel } from '@shared/VideoDetailPanel';
import { parseVideoInfoResult, videoInfoToMeta } from '@shared/videoInfo';

type TranscriptData = {
  videoId: string;
  type: 'official' | 'auto';
  lang: string;
  text: string;
  next_cursor?: string;
  is_truncated: boolean;
  total_length: number;
  start_offset: number;
  end_offset: number;
  source?: string;
};

function parseTranscriptResult(result: CallToolResult): TranscriptData | null {
  const structured = result.structuredContent as TranscriptData | undefined;
  if (
    structured?.videoId != null &&
    typeof structured.text === 'string' &&
    structured.type != null &&
    structured.lang != null
  ) {
    return structured;
  }

  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as TranscriptData;
    return parsed.videoId != null && parsed.text != null ? parsed : null;
  } catch {
    return null;
  }
}

function TranscriptApp() {
  const [video, setVideo] = useState<VideoMeta | null>(null);
  const [preferredTrack, setPreferredTrack] = useState<SubtitleTrack | null>(null);
  const [status, setStatus] = useState<'waiting' | 'ready'>('waiting');
  const [appRef, setAppRef] = useState<App | null>(null);

  const subtitles = useSubtitles(appRef, video?.videoId, { preferredTrack });

  const loadVideoMeta = useCallback(
    async (videoId: string): Promise<VideoMeta | null> => {
      if (!appRef) return null;

      const fallback: VideoMeta = {
        videoId,
        title: null,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        duration: null,
        uploader: null,
        viewCount: null,
        thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
      };

      try {
        const result = await appRef.callServerTool({
          name: 'get_video_info',
          arguments: { url: videoId },
        });

        if (result.isError) return fallback;

        const info = parseVideoInfoResult(result);
        return info ? videoInfoToMeta(info) : fallback;
      } catch {
        return fallback;
      }
    },
    [appRef]
  );

  const handleTranscriptResult = useCallback(
    async (parsed: TranscriptData) => {
      setStatus('ready');
      subtitles.reset();
      setPreferredTrack({ type: parsed.type, lang: parsed.lang });
      const meta = await loadVideoMeta(parsed.videoId);
      if (meta) setVideo(meta);
      notifyHostAboutResize();
    },
    [loadVideoMeta, subtitles]
  );

  const { isConnected, error } = useApp({
    appInfo: { name: 'TranscriptReader', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      setAppRef(createdApp);
      createdApp.ontoolresult = (result) => {
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        if (structured?.results) return;

        const transcript = parseTranscriptResult(result);
        if (transcript) {
          void handleTranscriptResult(transcript);
          return;
        }

        setStatus('ready');
      };
    },
  });

  useHostStyles(appRef);

  const handleOpenExternal = useCallback(
    async (seconds?: number) => {
      if (!video) return;
      const url = seconds != null ? youtubeWatchUrlAt(video, seconds) : youtubeWatchUrl(video);
      if (appRef) {
        await appRef.openLink({ url });
      } else {
        globalThis.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [appRef, video]
  );

  useEffect(() => {
    notifyHostAboutResize();
  }, [video, subtitles.cuesStatus, subtitles.cues.length, subtitles.isTruncated, subtitles.tracksLoading]);

  if (error) {
    return <div style={styles.centered}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={styles.centered}>Connecting…</div>;
  }

  return (
    <AppShell title="Transcript">
      {status === 'waiting' && (
        <div style={styles.centered}>Waiting for video or transcript…</div>
      )}

      {video && (
        <VideoDetailPanel video={video} onOpen={() => void handleOpenExternal()}>
          <SubtitlesPanel
            cues={subtitles.cues}
            status={subtitles.cuesStatus}
            video={video}
            onOpenAtTime={(seconds) => void handleOpenExternal(seconds)}
            onLoadSubtitles={subtitles.loadSubtitles}
            onLoadMore={subtitles.handleLoadMore}
            isTruncated={subtitles.isTruncated}
            loadingMore={subtitles.loadingMore}
            availableTracks={subtitles.availableTracks}
            selectedTrack={subtitles.selectedTrack}
            onTrackSelect={subtitles.handleTrackSelect}
            tracksLoading={subtitles.tracksLoading}
          />
        </VideoDetailPanel>
      )}
    </AppShell>
  );
}

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <TranscriptApp />
    </StrictMode>
  );
}
