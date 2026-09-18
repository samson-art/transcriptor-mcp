import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import React, { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@shared/AppShell';
import { isYouTubePage, pageFromInput, watchUrlAt, youtubeWatchUrl } from '@shared/format';
import { notifyHostAboutResize } from '@shared/resize';
import type { SubtitleTrack } from '@shared/subtitleTracks';
import { SubtitlesPanel } from '@shared/SubtitlesPanel';
import { styles } from '@shared/styles';
import type { VideoMeta } from '@shared/types';
import { useSubtitles } from '@shared/useSubtitles';
import { WIDGET_CALL_META } from '@shared/widgetCall';
import { VideoDetailPanel } from '@shared/VideoDetailPanel';
import { parseVideoInfoResult, videoInfoToMeta } from '@shared/videoInfo';

type TranscriptData = {
  videoId: string;
  /** The page the transcript is of, as the server resolved it (1.5.0+). */
  url?: string;
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

/**
 * The page the transcript is of. The result's own `url` first; then what the model
 * passed, where a bare id is YouTube by the server's contract; then the id, but only
 * when the server said it came from YouTube. Anything else: unknown, not YouTube.
 */
function pageUrlOf(parsed: TranscriptData, input: string | null): string | null {
  if (parsed.url) return parsed.url;
  if (input) return pageFromInput(input);
  if (parsed.source === 'youtube') return youtubeWatchUrl({ videoId: parsed.videoId, url: null });
  return null;
}

function TranscriptApp() {
  const [video, setVideo] = useState<VideoMeta | null>(null);
  const [preferredTrack, setPreferredTrack] = useState<SubtitleTrack | null>(null);
  const [status, setStatus] = useState<'waiting' | 'ready'>('waiting');
  const [appRef, setAppRef] = useState<App | null>(null);

  // The url the model passed to the tool, set by `ontoolinput` and read from the
  // `ontoolresult` closure. Only a fallback for results older than 1.5.0, which do
  // not carry `url`: some hosts (Claude Code) never deliver the call's arguments.
  const sourceRef = useRef<string | null>(null);

  // The URL get_transcript was served under. The server keyed its caches by this exact
  // string (track list, subtitles, a Whisper job), so the widget's own calls use it;
  // yt-dlp's canonical webpageUrl would miss them and fetch or transcribe again.
  // The canonical one stays in `video.url`, for Open and cue links.
  const [page, setPage] = useState<string | null>(null);

  const subtitles = useSubtitles(appRef, page, { preferredTrack });

  // Takes the app instead of reading `appRef`: this runs from the `ontoolresult`
  // handler installed in `onAppCreated`, whose closure still sees `appRef` as null.
  const loadVideoMeta = useCallback(
    async (app: App, videoId: string, source: string | null): Promise<VideoMeta> => {
      const bare: VideoMeta = {
        videoId,
        title: null,
        url: source,
        duration: null,
        uploader: null,
        viewCount: null,
        // Only a YouTube page makes the id a YouTube id.
        thumbnail:
          source && isYouTubePage(source)
            ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
            : null,
      };
      // Without a page URL the id could be from any platform; asking the server
      // would ask YouTube about it. Show what is known and call nothing.
      if (!source) return bare;

      try {
        const result = await app.callServerTool({
          name: 'get_video_info',
          _meta: WIDGET_CALL_META,
          arguments: { url: source },
        });

        if (result.isError) return bare;

        const info = parseVideoInfoResult(result);
        if (!info) return bare;
        const meta = videoInfoToMeta(info);
        return { ...meta, url: meta.url ?? source };
      } catch {
        return bare;
      }
    },
    []
  );

  const handleTranscriptResult = useCallback(
    async (app: App, parsed: TranscriptData) => {
      setStatus('ready');
      subtitles.reset();
      setPreferredTrack({ type: parsed.type, lang: parsed.lang });
      const source = pageUrlOf(parsed, sourceRef.current);
      setPage(source);
      const meta = await loadVideoMeta(app, parsed.videoId, source);
      setVideo(meta);
      notifyHostAboutResize();
    },
    [loadVideoMeta, subtitles]
  );

  const { isConnected, error } = useApp({
    appInfo: { name: 'TranscriptReader', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      setAppRef(createdApp);
      createdApp.ontoolinput = (input) => {
        const url = input.arguments?.url;
        if (typeof url === 'string' && url.trim()) {
          sourceRef.current = url.trim();
        }
      };
      createdApp.ontoolresult = (result) => {
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        if (structured?.results) return;

        const transcript = parseTranscriptResult(result);
        if (transcript) {
          void handleTranscriptResult(createdApp, transcript);
          return;
        }

        setStatus('ready');
      };
    },
  });

  useHostStyles(appRef);

  const handleOpenExternal = useCallback(
    async (seconds?: number) => {
      if (!video?.url) return;
      const url = seconds != null ? watchUrlAt(video.url, seconds) : video.url;
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
        <VideoDetailPanel
          video={video}
          onOpen={video.url ? () => void handleOpenExternal() : undefined}
        >
          {video.url && (
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
          )}
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
