import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import React, { StrictMode, useCallback, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@shared/AppShell';
import { youtubeWatchUrlAt } from '@shared/format';
import { notifyHostAboutResize } from '@shared/resize';
import { styles } from '@shared/styles';

type FrameData = {
  videoId: string | null;
  timestampSeconds: number | null;
  timestamp: string | null;
  mimeType: string;
  sizeBytes: number | null;
  width: number | null;
  imageDataUri: string;
};

type CaptureOptions = {
  format?: 'png' | 'jpeg';
  width?: number;
  quality?: number;
};

function parseVideoFrameResult(result: CallToolResult): FrameData | null {
  const image = result.content?.find((block) => block.type === 'image');
  if (!image || typeof image.data !== 'string' || !image.data) return null;

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const mimeType = typeof image.mimeType === 'string' ? image.mimeType : 'image/jpeg';

  return {
    videoId: typeof structured.videoId === 'string' ? structured.videoId : null,
    timestampSeconds:
      typeof structured.timestampSeconds === 'number' ? structured.timestampSeconds : null,
    timestamp: typeof structured.timestamp === 'string' ? structured.timestamp : null,
    mimeType,
    sizeBytes: typeof structured.sizeBytes === 'number' ? structured.sizeBytes : null,
    width: typeof structured.width === 'number' ? structured.width : null,
    imageDataUri: `data:${mimeType};base64,${image.data}`,
  };
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Plain seconds ("83", "83.5") become a seconds arg, anything else is a server-side timecode. */
function timeInputToArgs(value: string): { seconds: number } | { timecode: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return { seconds: Number.parseFloat(trimmed) };
  return { timecode: trimmed };
}

function VideoFrameApp() {
  const [frame, setFrame] = useState<FrameData | null>(null);
  const [status, setStatus] = useState<'waiting' | 'loading' | 'ready' | 'error'>('waiting');
  const [appRef, setAppRef] = useState<App | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [captureOptions, setCaptureOptions] = useState<CaptureOptions>({});
  const [timeInput, setTimeInput] = useState('');

  const handleToolResult = useCallback((result: CallToolResult) => {
    if (result.isError) {
      setStatus('error');
      notifyHostAboutResize();
      return;
    }

    const parsed = parseVideoFrameResult(result);
    if (!parsed) return;

    setFrame(parsed);
    setStatus('ready');
    notifyHostAboutResize();
  }, []);

  const capture = useCallback(
    async (timestampArgs: { seconds?: number; timecode?: string }) => {
      if (!appRef || !sourceUrl) return;
      setStatus('loading');
      notifyHostAboutResize();
      try {
        const result = await appRef.callServerTool({
          name: 'get_video_frame',
          arguments: { url: sourceUrl, ...captureOptions, ...timestampArgs },
        });
        handleToolResult(result);
      } catch {
        setStatus('error');
        notifyHostAboutResize();
      }
    },
    [appRef, sourceUrl, captureOptions, handleToolResult]
  );

  const { isConnected, error } = useApp({
    appInfo: { name: 'VideoFrame', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      setAppRef(app);

      app.ontoolresult = (result) => {
        handleToolResult(result);
      };

      app.ontoolinput = (input) => {
        const args = (input.arguments ?? {}) as Record<string, unknown>;
        if (typeof args.url === 'string' && args.url.trim()) {
          setSourceUrl(args.url.trim());
        }
        const options: CaptureOptions = {};
        if (args.format === 'png' || args.format === 'jpeg') options.format = args.format;
        if (typeof args.width === 'number') options.width = args.width;
        if (typeof args.quality === 'number') options.quality = args.quality;
        setCaptureOptions(options);
      };
    },
  });

  useHostStyles(appRef);

  const handleOpenExternal = useCallback(async () => {
    if (!frame?.videoId && !sourceUrl) return;
    const url = youtubeWatchUrlAt(
      {
        videoId: frame?.videoId ?? '',
        url: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null,
      },
      frame?.timestampSeconds ?? 0
    );
    if (appRef) {
      await appRef.openLink({ url });
    } else {
      globalThis.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [appRef, frame, sourceUrl]);

  const handleCaptureClick = useCallback(() => {
    const args = timeInputToArgs(timeInput);
    if (!args) return;
    void capture(args);
  }, [capture, timeInput]);

  const handleStep = useCallback(
    (delta: number) => {
      const current = frame?.timestampSeconds ?? 0;
      void capture({ seconds: Math.max(0, current + delta) });
    },
    [capture, frame]
  );

  useEffect(() => {
    notifyHostAboutResize();
  }, [frame, status]);

  if (error) {
    return <div style={styles.centered}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={styles.centered}>Connecting…</div>;
  }

  const busy = status === 'loading';
  const canCapture = Boolean(appRef && sourceUrl);
  const metaLine = frame
    ? [
        frame.timestamp,
        frame.width != null ? `${frame.width}px` : null,
        formatBytes(frame.sizeBytes),
        frame.mimeType,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <AppShell title="Video frame">
      {status === 'waiting' && <div style={styles.centered}>Waiting for video frame…</div>}
      {status === 'loading' && <div style={styles.centered}>Capturing frame…</div>}
      {status === 'error' && <div style={styles.centered}>Failed to capture frame.</div>}

      {frame && status !== 'loading' && (
        <div style={frameWrapStyle}>
          <img
            src={frame.imageDataUri}
            alt={frame.timestamp ? `Video frame at ${frame.timestamp}` : 'Video frame'}
            style={frameImgStyle}
            onLoad={notifyHostAboutResize}
          />
          {metaLine && <div style={frameMetaStyle}>{metaLine}</div>}
        </div>
      )}

      {canCapture && (
        <div style={controlsRowStyle}>
          {frame && (
            <>
              <button
                type="button"
                style={styles.loadMoreBtn}
                disabled={busy}
                onClick={() => handleStep(-10)}
              >
                −10s
              </button>
              <button
                type="button"
                style={styles.loadMoreBtn}
                disabled={busy}
                onClick={() => handleStep(-1)}
              >
                −1s
              </button>
              <button
                type="button"
                style={styles.loadMoreBtn}
                disabled={busy}
                onClick={() => handleStep(1)}
              >
                +1s
              </button>
              <button
                type="button"
                style={styles.loadMoreBtn}
                disabled={busy}
                onClick={() => handleStep(10)}
              >
                +10s
              </button>
            </>
          )}
          <input
            type="text"
            value={timeInput}
            placeholder="mm:ss or seconds"
            style={timeInputStyle}
            disabled={busy}
            onChange={(event) => setTimeInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleCaptureClick();
            }}
          />
          <button
            type="button"
            style={styles.loadMoreBtn}
            disabled={busy || !timeInput.trim()}
            onClick={handleCaptureClick}
          >
            Capture
          </button>
          {frame && (
            <button
              type="button"
              style={styles.loadMoreBtn}
              onClick={() => void handleOpenExternal()}
            >
              Watch ↗
            </button>
          )}
        </div>
      )}
    </AppShell>
  );
}

const frameWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const frameImgStyle: CSSProperties = {
  width: '100%',
  display: 'block',
  borderRadius: '8px',
  border: '1px solid var(--color-border-primary, var(--app-border, rgba(127,127,127,0.25)))',
  boxSizing: 'border-box',
};

const frameMetaStyle: CSSProperties = {
  fontSize: '12px',
  opacity: 0.65,
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
};

const controlsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
  marginTop: '10px',
};

const timeInputStyle: CSSProperties = {
  flex: 1,
  minWidth: '110px',
  padding: '6px 8px',
  borderRadius: '6px',
  border: '1px solid var(--color-border-primary, var(--app-border, rgba(127,127,127,0.25)))',
  background: 'var(--color-background-secondary, var(--app-surface, rgba(127,127,127,0.08)))',
  color: 'inherit',
  outline: 'none',
  fontSize: '12px',
  boxSizing: 'border-box',
};

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <VideoFrameApp />
    </StrictMode>
  );
}
