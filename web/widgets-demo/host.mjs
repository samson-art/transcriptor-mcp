/**
 * MCP Apps host for the landing page's live widget demos.
 *
 * The Widgets section embeds the REAL production widget bundles
 * (dist/ui/*.html, the same files the server serves as ui:// resources)
 * in iframes. This script plays the host side of the MCP Apps protocol
 * with the official AppBridge: it answers ui/initialize, pushes a
 * recorded tool result, serves the widgets' follow-up tools/call
 * requests from fixtures, opens external links, and syncs each
 * iframe's height from ui/notifications/size-changed.
 *
 * fixtures.json is real data recorded from YouTube via yt-dlp/ffmpeg
 * (see README.md in this directory) — the widgets behave exactly as
 * they do in a chat, minus the network.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import fixtures from './fixtures.json';

const HERO = fixtures.hero.videoId;
const MAX_TILE_HEIGHT = 760;

function textResult(structured, text) {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function extractVideoId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/[?&]v=([^&]+)/) ?? trimmed.match(/youtu\.be\/([^?&/]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function parseTimecode(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  const [, h, m, s] = match;
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s);
}

function formatTimestamp(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${h}:${m}:${s}.000`;
}

function frameResult(targetSeconds) {
  const times = Object.keys(fixtures.frames.byTime).map(Number);
  const best = times.reduce((a, b) =>
    Math.abs(b - targetSeconds) < Math.abs(a - targetSeconds) ? b : a
  );
  const frame = fixtures.frames.byTime[String(best)];
  return {
    content: [
      { type: 'text', text: `Frame captured at ${formatTimestamp(best)}` },
      { type: 'image', data: frame.b64, mimeType: 'image/jpeg' },
    ],
    structuredContent: {
      videoId: fixtures.frames.videoId,
      timestampSeconds: best,
      timestamp: formatTimestamp(best),
      mimeType: 'image/jpeg',
      sizeBytes: frame.sizeBytes,
      width: fixtures.frames.width,
    },
  };
}

function videoInfoResult(videoId) {
  if (videoId === HERO) return textResult(fixtures.hero.info);
  const meta = fixtures.search.results.find((r) => r.videoId === videoId);
  return textResult({
    videoId,
    title: meta?.title ?? null,
    uploader: meta?.uploader ?? null,
    channel: meta?.uploader ?? null,
    duration: meta?.duration ?? null,
    webpageUrl: meta?.url ?? `https://www.youtube.com/watch?v=${videoId}`,
    viewCount: meta?.viewCount ?? null,
    thumbnail: meta?.thumbnail ?? null,
  });
}

async function handleToolCall({ name, arguments: args = {} }) {
  const videoId = extractVideoId(args.url) ?? HERO;
  switch (name) {
    case 'get_video_info':
      return videoInfoResult(videoId);
    case 'get_available_subtitles': {
      const entry = fixtures.subtitles[videoId];
      return textResult({
        videoId,
        official: entry?.tracks.official ?? [],
        auto: entry?.tracks.auto ?? [],
      });
    }
    case 'get_raw_subtitles': {
      const entry = fixtures.subtitles[videoId];
      if (!entry) {
        return { content: [{ type: 'text', text: 'No subtitles found.' }], isError: true };
      }
      return {
        content: [{ type: 'text', text: entry.srt }],
        structuredContent: {
          videoId,
          type: entry.tracks.official.length > 0 ? 'official' : 'auto',
          lang: typeof args.lang === 'string' ? args.lang : 'en',
          format: 'srt',
          content: entry.srt,
          is_truncated: false,
          total_length: entry.srt.length,
          start_offset: 0,
          end_offset: entry.srt.length,
        },
      };
    }
    case 'get_video_frame': {
      const target =
        typeof args.seconds === 'number' ? args.seconds : (parseTimecode(args.timecode) ?? 110);
      return frameResult(target);
    }
    default:
      return {
        content: [{ type: 'text', text: `${name} is not available in this demo.` }],
        isError: true,
      };
  }
}

const TILES = [
  {
    id: 'search',
    input: { query: fixtures.search.query, limit: fixtures.search.results.length },
    result: () => textResult({ results: fixtures.search.results }),
  },
  {
    id: 'transcript',
    input: { url: HERO },
    result: () =>
      textResult(fixtures.hero.transcript, fixtures.hero.transcript.text),
  },
  {
    id: 'video-info',
    input: { url: HERO },
    result: () => videoInfoResult(HERO),
  },
  {
    id: 'video-frame',
    input: { url: HERO, seconds: 110 },
    result: () => frameResult(110),
  },
];

async function boot(holder, tile) {
  const iframe = holder.querySelector('iframe');
  iframe.src = `/widgets/${tile.id}.html`;
  await new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));

  const bridge = new AppBridge(
    null,
    { name: 'transcriptor-landing', version: '1.0.0' },
    {},
    { hostContext: { displayMode: 'inline', platform: 'web' } }
  );
  bridge.oncalltool = (params) => handleToolCall(params);
  bridge.onopenlink = async ({ url }) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return {};
  };
  bridge.onsizechange = ({ height }) => {
    if (typeof height === 'number' && height > 0) {
      iframe.style.height = `${Math.min(Math.ceil(height) + 2, MAX_TILE_HEIGHT)}px`;
    }
  };
  bridge.oninitialized = () => {
    void (async () => {
      await bridge.sendToolInput({ arguments: tile.input });
      await bridge.sendToolResult(tile.result());
    })();
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
}

const pending = new Map();

function bootTile(tile) {
  const holder = pending.get(tile);
  if (!holder) return;
  pending.delete(tile);
  void boot(holder, tile);
}

for (const tile of TILES) {
  const holder = document.querySelector(`[data-widget="${tile.id}"]`);
  if (!holder) continue;
  pending.set(tile, holder);
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        bootTile(tile);
      }
    },
    { rootMargin: '500px' }
  );
  observer.observe(holder);
}

// Escape hatch for environments where IntersectionObserver never fires
// (headless captures, suspended background panes) and for debugging.
window.__bootWidgets = () => [...pending.keys()].forEach(bootTile);
