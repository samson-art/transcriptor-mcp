import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import React, { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@shared/AppShell';
import { CollapsibleDescription } from '@shared/CollapsibleDescription';
import { youtubeWatchUrl, youtubeWatchUrlAt } from '@shared/format';
import { notifyHostAboutResize } from '@shared/resize';
import { SubtitlesPanel } from '@shared/SubtitlesPanel';
import { styles } from '@shared/styles';
import type { VideoMeta } from '@shared/types';
import { useSubtitles } from '@shared/useSubtitles';
import { VideoDetailPanel } from '@shared/VideoDetailPanel';
import {
  parseVideoInfoResult,
  videoInfoToMeta,
  type VideoInfoData,
} from '@shared/videoInfo';

function formatUploadDate(value: string | null | undefined): string | null {
  if (!value || value.length !== 8) return null;
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function formatLikes(count: number | null | undefined): string | null {
  if (count == null) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M likes`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K likes`;
  return `${count} likes`;
}

function applyVideoInfo(info: VideoInfoData): { video: VideoMeta; info: VideoInfoData } {
  return { video: videoInfoToMeta(info), info };
}

function VideoInfoApp() {
  const [video, setVideo] = useState<VideoMeta | null>(null);
  const [info, setInfo] = useState<VideoInfoData | null>(null);
  const [status, setStatus] = useState<'waiting' | 'ready' | 'error'>('waiting');
  const [appRef, setAppRef] = useState<App | null>(null);

  const subtitles = useSubtitles(appRef, video?.videoId);

  const handleToolResult = useCallback((result: CallToolResult) => {
    if (result.isError) {
      setStatus('error');
      notifyHostAboutResize();
      return;
    }

    const parsed = parseVideoInfoResult(result);
    if (!parsed) return;

    const next = applyVideoInfo(parsed);
    setVideo(next.video);
    setInfo(next.info);
    setStatus('ready');
    notifyHostAboutResize();
  }, []);

  const fetchVideoInfo = useCallback(async (app: App, url: string) => {
    try {
      const result = await app.callServerTool({
        name: 'get_video_info',
        arguments: { url },
      });
      handleToolResult(result);
    } catch {
      setStatus('error');
      notifyHostAboutResize();
    }
  }, [handleToolResult]);

  const { isConnected, error } = useApp({
    appInfo: { name: 'VideoInfo', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      setAppRef(app);

      app.ontoolresult = (result) => {
        handleToolResult(result);
      };

      app.ontoolinput = (input) => {
        const url = input.arguments?.url;
        if (typeof url === 'string' && url.trim()) {
          void fetchVideoInfo(app, url.trim());
        }
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
  }, [video, info, status, subtitles.cuesStatus, subtitles.cues.length, subtitles.tracksLoading]);

  if (error) {
    return <div style={styles.centered}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={styles.centered}>Connecting…</div>;
  }

  const uploadDate = formatUploadDate(info?.uploadDate);
  const likes = formatLikes(info?.likeCount);

  return (
    <AppShell title="Video info">
      {status === 'waiting' && <div style={styles.centered}>Waiting for video info…</div>}
      {status === 'error' && <div style={styles.centered}>Failed to load video info.</div>}

      {video && (
        <VideoDetailPanel video={video} onOpen={() => void handleOpenExternal()}>
          {(uploadDate || likes || info?.commentCount != null) && (
            <div style={infoStatsStyle}>
              {[uploadDate, likes, info?.commentCount != null ? `${info.commentCount} comments` : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          {info?.description?.trim() && (
            <CollapsibleDescription description={info.description} />
          )}
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

const infoStatsStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '12px',
  opacity: 0.75,
};

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <VideoInfoApp />
    </StrictMode>
  );
}
