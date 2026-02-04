import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// IMPORTANT: use Zod v3 schemas for MCP JSON Schema compatibility.
// Some MCP clients (e.g. n8n) are strict about JSON Schema shapes and can fail
// on Zod v4 JSON schema output ($ref-heavy / missing "type" in some branches).
// The MCP SDK already supports Zod v3 via `zod/v3` + `zod-to-json-schema`.
import { z } from 'zod/v3';
import {
  detectSubtitleFormat,
  downloadSubtitles,
  extractVideoId,
  fetchAvailableSubtitles,
  fetchVideoChapters,
  fetchVideoInfo,
  parseSubtitles,
  type VideoChapter,
} from './youtube.js';
import { isValidYouTubeUrl, sanitizeLang, sanitizeVideoId } from './validation.js';

const DEFAULT_RESPONSE_LIMIT = 50000;
const MAX_RESPONSE_LIMIT = 200000;
const MIN_RESPONSE_LIMIT = 1000;

const baseInputSchema = z.object({
  url: z.string().min(1).describe('YouTube URL or video ID'),
});

const subtitleInputSchema = baseInputSchema.extend({
  type: z.enum(['official', 'auto']).optional().default('auto'),
  lang: z.string().optional().default('en'),
  response_limit: z.number().int().min(MIN_RESPONSE_LIMIT).max(MAX_RESPONSE_LIMIT).optional(),
  next_cursor: z.string().optional(),
});

const transcriptOutputSchema = z.object({
  videoId: z.string(),
  type: z.enum(['official', 'auto']),
  lang: z.string(),
  text: z.string(),
  next_cursor: z.string().optional(),
  is_truncated: z.boolean(),
  total_length: z.number(),
  start_offset: z.number(),
  end_offset: z.number(),
});

const rawSubtitlesOutputSchema = z.object({
  videoId: z.string(),
  type: z.enum(['official', 'auto']),
  lang: z.string(),
  format: z.enum(['srt', 'vtt']),
  content: z.string(),
  next_cursor: z.string().optional(),
  is_truncated: z.boolean(),
  total_length: z.number(),
  start_offset: z.number(),
  end_offset: z.number(),
});

const availableSubtitlesOutputSchema = z.object({
  videoId: z.string(),
  official: z.array(z.string()),
  auto: z.array(z.string()),
});

const videoInfoOutputSchema = z.object({
  videoId: z.string(),
  title: z.string().nullable(),
  uploader: z.string().nullable(),
  uploaderId: z.string().nullable(),
  channel: z.string().nullable(),
  channelId: z.string().nullable(),
  channelUrl: z.string().nullable(),
  duration: z.number().nullable(),
  description: z.string().nullable(),
  uploadDate: z.string().nullable(),
  webpageUrl: z.string().nullable(),
  viewCount: z.number().nullable(),
  likeCount: z.number().nullable(),
  commentCount: z.number().nullable(),
  tags: z.array(z.string()).nullable(),
  categories: z.array(z.string()).nullable(),
  liveStatus: z.string().nullable(),
  isLive: z.boolean().nullable(),
  wasLive: z.boolean().nullable(),
  availability: z.string().nullable(),
  thumbnail: z.string().nullable(),
  thumbnails: z
    .array(
      z.object({
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        id: z.string().optional(),
      })
    )
    .nullable(),
});

const videoChaptersOutputSchema = z.object({
  videoId: z.string(),
  chapters: z.array(
    z.object({
      startTime: z.number(),
      endTime: z.number(),
      title: z.string(),
    })
  ),
});

type TextContent = { type: 'text'; text: string };

function textContent(text: string): TextContent {
  return { type: 'text', text };
}

export function createMcpServer() {
  const server = new McpServer({
    name: 'yt-captions-downloader',
    version: '0.2.0',
  });

  /**
   * Get YouTube transcript
   * @param args - Arguments for the tool
   * @returns Transcript
   */
  server.registerTool(
    'get_transcript',
    {
      title: 'Get YouTube transcript',
      description: 'Fetch cleaned subtitles as plain text for a YouTube video.',
      inputSchema: subtitleInputSchema,
      outputSchema: transcriptOutputSchema,
    },
    async (args, _extra) => {
      const { videoId, lang, type, responseLimit, nextCursor } = resolveSubtitleArgs(args);
      const subtitlesContent = await downloadSubtitles(videoId, type, lang);
      if (!subtitlesContent) {
        return toolError(`Subtitles not found for "${videoId}" (${type}, ${lang}).`);
      }

      let plainText: string;
      try {
        plainText = parseSubtitles(subtitlesContent);
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : 'Failed to parse subtitles content.'
        );
      }

      const page = paginateText(plainText, responseLimit, nextCursor);
      return {
        content: [textContent(page.chunk)],
        structuredContent: {
          videoId,
          type,
          lang,
          text: page.chunk,
          next_cursor: page.nextCursor,
          is_truncated: page.isTruncated,
          total_length: page.totalLength,
          start_offset: page.startOffset,
          end_offset: page.endOffset,
        },
      };
    }
  );

  /**
   * Get raw YouTube subtitles
   * @param args - Arguments for the tool
   * @returns Raw subtitles
   */
  server.registerTool(
    'get_raw_subtitles',
    {
      title: 'Get raw YouTube subtitles',
      description: 'Fetch raw SRT/VTT subtitles for a YouTube video.',
      inputSchema: subtitleInputSchema,
      outputSchema: rawSubtitlesOutputSchema,
    },
    async (args, _extra) => {
      const { videoId, lang, type, responseLimit, nextCursor } = resolveSubtitleArgs(args);
      const subtitlesContent = await downloadSubtitles(videoId, type, lang);
      if (!subtitlesContent) {
        return toolError(`Subtitles not found for "${videoId}" (${type}, ${lang}).`);
      }

      const format = detectSubtitleFormat(subtitlesContent);
      const page = paginateText(subtitlesContent, responseLimit, nextCursor);
      return {
        content: [textContent(page.chunk)],
        structuredContent: {
          videoId,
          type,
          lang,
          format,
          content: page.chunk,
          next_cursor: page.nextCursor,
          is_truncated: page.isTruncated,
          total_length: page.totalLength,
          start_offset: page.startOffset,
          end_offset: page.endOffset,
        },
      };
    }
  );

  /**
   * Get available subtitle languages
   * @param args - Arguments for the tool
   * @returns Available subtitle languages
   */
  server.registerTool(
    'get_available_subtitles',
    {
      title: 'Get available subtitle languages',
      description: 'List available official and auto-generated subtitle languages.',
      inputSchema: baseInputSchema,
      outputSchema: availableSubtitlesOutputSchema,
    },
    async (args, _extra) => {
      const videoId = resolveVideoId(args.url);
      if (!videoId) {
        return toolError('Invalid YouTube URL or video ID.');
      }

      const available = await fetchAvailableSubtitles(videoId);
      if (!available) {
        return toolError(`Failed to fetch subtitle availability for "${videoId}".`);
      }

      const text = [
        `Official: ${available.official.length ? available.official.join(', ') : 'none'}`,
        `Auto: ${available.auto.length ? available.auto.join(', ') : 'none'}`,
      ].join('\n');

      return {
        content: [textContent(text)],
        structuredContent: {
          videoId,
          official: available.official,
          auto: available.auto,
        },
      };
    }
  );

  /**
   * Get YouTube video info
   * @param args - Arguments for the tool
   * @returns Video info
   */
  server.registerTool(
    'get_video_info',
    {
      title: 'Get YouTube video info',
      description:
        'Fetch extended metadata for a YouTube video (title, channel, duration, tags, thumbnails, etc.).',
      inputSchema: baseInputSchema,
      outputSchema: videoInfoOutputSchema,
    },
    async (args, _extra) => {
      const videoId = resolveVideoId(args.url);
      if (!videoId) {
        return toolError('Invalid YouTube URL or video ID.');
      }

      const info = await fetchVideoInfo(videoId);
      if (!info) {
        return toolError(`Failed to fetch video info for "${videoId}".`);
      }

      const textLines = [
        info.title ? `Title: ${info.title}` : null,
        info.channel ? `Channel: ${info.channel}` : null,
        info.duration === null ? null : `Duration: ${info.duration}s`,
        info.viewCount !== null ? `Views: ${info.viewCount}` : null,
        info.webpageUrl ? `URL: ${info.webpageUrl}` : null,
      ].filter(Boolean) as string[];

      return {
        content: [textContent(textLines.join('\n'))],
        structuredContent: {
          videoId,
          title: info.title,
          uploader: info.uploader,
          uploaderId: info.uploaderId,
          channel: info.channel,
          channelId: info.channelId,
          channelUrl: info.channelUrl,
          duration: info.duration,
          description: info.description,
          uploadDate: info.uploadDate,
          webpageUrl: info.webpageUrl,
          viewCount: info.viewCount,
          likeCount: info.likeCount,
          commentCount: info.commentCount,
          tags: info.tags,
          categories: info.categories,
          liveStatus: info.liveStatus,
          isLive: info.isLive,
          wasLive: info.wasLive,
          availability: info.availability,
          thumbnail: info.thumbnail,
          thumbnails: info.thumbnails,
        },
      };
    }
  );

  /**
   * Get YouTube video chapters
   * @param args - Arguments for the tool
   * @returns Video chapters
   */
  server.registerTool(
    'get_video_chapters',
    {
      title: 'Get YouTube video chapters',
      description: 'Fetch chapter markers (start/end time, title) for a YouTube video.',
      inputSchema: baseInputSchema,
      outputSchema: videoChaptersOutputSchema,
    },
    async (args, _extra) => {
      const videoId = resolveVideoId(args.url);
      if (!videoId) {
        return toolError('Invalid YouTube URL or video ID.');
      }

      const chapters = await fetchVideoChapters(videoId);
      if (chapters === null) {
        return toolError(`Failed to fetch chapters for "${videoId}".`);
      }

      const text =
        chapters.length === 0
          ? `No chapters found for "${videoId}".`
          : chapters
              .map((ch: VideoChapter) => `${ch.startTime}s - ${ch.endTime}s: ${ch.title}`)
              .join('\n');

      return {
        content: [textContent(text)],
        structuredContent: {
          videoId,
          chapters,
        },
      };
    }
  );

  return server;
}

function resolveSubtitleArgs(args: z.infer<typeof subtitleInputSchema>) {
  const videoId = resolveVideoId(args.url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL or video ID.');
  }

  const lang = sanitizeLang(args.lang ?? 'en');
  if (!lang) {
    throw new Error('Invalid language code.');
  }

  const responseLimit = args.response_limit ?? DEFAULT_RESPONSE_LIMIT;
  const nextCursor = args.next_cursor;
  const type = args.type ?? 'auto';

  return { videoId, lang, responseLimit, nextCursor, type };
}

function resolveVideoId(input: string): string | null {
  if (isValidYouTubeUrl(input)) {
    const extracted = extractVideoId(input);
    if (!extracted) {
      return null;
    }
    return sanitizeVideoId(extracted);
  }

  return sanitizeVideoId(input);
}

function paginateText(text: string, limit: number, nextCursor?: string) {
  const totalLength = text.length;
  const startOffset = nextCursor ? Number.parseInt(nextCursor, 10) : 0;

  if (Number.isNaN(startOffset) || startOffset < 0 || startOffset > totalLength) {
    throw new Error('Invalid next_cursor value.');
  }

  const endOffset = Math.min(startOffset + limit, totalLength);
  const chunk = text.slice(startOffset, endOffset);
  const isTruncated = endOffset < totalLength;
  const next = isTruncated ? String(endOffset) : undefined;

  return {
    chunk,
    nextCursor: next,
    isTruncated,
    totalLength,
    startOffset,
    endOffset,
  };
}

function toolError(message: string) {
  return {
    content: [textContent(message)],
    isError: true,
  };
}
