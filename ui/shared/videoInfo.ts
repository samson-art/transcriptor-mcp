import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VideoMeta } from './types.js';

export type VideoInfoData = {
  videoId: string;
  title: string | null;
  uploader: string | null;
  channel: string | null;
  duration: number | null;
  webpageUrl: string | null;
  viewCount: number | null;
  thumbnail: string | null;
  description?: string | null;
  uploadDate?: string | null;
  likeCount?: number | null;
  commentCount?: number | null;
};

function extractVideoId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/[?&]v=([^&]+)/) ?? trimmed.match(/youtu\.be\/([^?&/]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

export function isVideoInfoStructured(structured: Record<string, unknown>): boolean {
  if (typeof structured.videoId !== 'string') return false;
  if (structured.results) return false;
  if (Array.isArray(structured.official) || Array.isArray(structured.auto)) return false;
  if (typeof structured.text === 'string') return false;
  return (
    'title' in structured ||
    'channel' in structured ||
    'description' in structured ||
    'viewCount' in structured ||
    'duration' in structured ||
    'webpageUrl' in structured
  );
}

function normalizeVideoInfo(structured: Record<string, unknown>): VideoInfoData {
  return {
    videoId: structured.videoId as string,
    title: (structured.title as string | null | undefined) ?? null,
    uploader: (structured.uploader as string | null | undefined) ?? null,
    channel: (structured.channel as string | null | undefined) ?? null,
    duration: (structured.duration as number | null | undefined) ?? null,
    webpageUrl: (structured.webpageUrl as string | null | undefined) ?? null,
    viewCount: (structured.viewCount as number | null | undefined) ?? null,
    thumbnail: (structured.thumbnail as string | null | undefined) ?? null,
    description: (structured.description as string | null | undefined) ?? null,
    uploadDate: (structured.uploadDate as string | null | undefined) ?? null,
    likeCount: (structured.likeCount as number | null | undefined) ?? null,
    commentCount: (structured.commentCount as number | null | undefined) ?? null,
  };
}

export function parseVideoInfoFromText(text: string): VideoInfoData | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (isVideoInfoStructured(parsed)) return normalizeVideoInfo(parsed);
  } catch {
    // fall through to line-based parser
  }

  const fields: Record<string, string> = {};
  for (const line of trimmed.split('\n')) {
    const match = line.match(/^(Title|Channel|Duration|Views|URL):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }

  const webpageUrl = fields.URL || null;
  const videoId = extractVideoId(webpageUrl) ?? extractVideoId(trimmed);
  if (!videoId) return null;

  const durationRaw = fields.Duration?.replace(/s$/, '');
  const duration = durationRaw ? Number.parseInt(durationRaw, 10) : null;
  const viewsRaw = fields.Views?.replace(/[^\d]/g, '');
  const viewCount = viewsRaw ? Number.parseInt(viewsRaw, 10) : null;

  return {
    videoId,
    title: fields.Title ?? null,
    uploader: fields.Channel ?? null,
    channel: fields.Channel ?? null,
    duration: Number.isFinite(duration) ? duration : null,
    webpageUrl,
    viewCount: Number.isFinite(viewCount) ? viewCount : null,
    thumbnail: null,
  };
}

export function parseVideoInfoResult(result: CallToolResult): VideoInfoData | null {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured && isVideoInfoStructured(structured)) {
    return normalizeVideoInfo(structured);
  }

  const textBlocks = result.content?.filter((block) => block.type === 'text') ?? [];
  for (const block of textBlocks) {
    const parsed = parseVideoInfoFromText(block.text);
    if (parsed) return parsed;
  }

  return null;
}

export function videoInfoToMeta(info: VideoInfoData): VideoMeta {
  return {
    videoId: info.videoId,
    title: info.title,
    url: info.webpageUrl,
    duration: info.duration,
    uploader: info.uploader ?? info.channel,
    viewCount: info.viewCount,
    thumbnail:
      info.thumbnail ?? `https://i.ytimg.com/vi/${encodeURIComponent(info.videoId)}/hqdefault.jpg`,
  };
}
