import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// IMPORTANT: use Zod v3 schemas for MCP JSON Schema compatibility.
// Some MCP clients (e.g. n8n) are strict about JSON Schema shapes and can fail
// on Zod v4 JSON schema output ($ref-heavy / missing "type" in some branches).
// The MCP SDK already supports Zod v3 via `zod/v3` + `zod-to-json-schema`.
import { z } from 'zod/v3';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import {
  detectSubtitleFormat,
  downloadSubtitles,
  extractVideoId,
  fetchAvailableSubtitles,
  fetchVideoChapters,
  fetchVideoInfo,
  fetchYtDlpJson,
  parseSubtitles,
  type VideoChapter,
} from './youtube.js';
import { normalizeVideoInput, sanitizeLang } from './validation.js';
import { version } from './version.js';
import { getWhisperConfig, transcribeWithWhisper } from './whisper.js';

function createDefaultLogger(): FastifyBaseLogger {
  return pino({ level: process.env.LOG_LEVEL || 'info' }) as unknown as FastifyBaseLogger;
}

const DEFAULT_RESPONSE_LIMIT = 50000;
const MAX_RESPONSE_LIMIT = 200000;
const MIN_RESPONSE_LIMIT = 1000;

const baseInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'Video URL (supported: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion) or YouTube video ID'
    ),
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
  source: z.enum(['youtube', 'whisper']).optional(),
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
  source: z.enum(['youtube', 'whisper']).optional(),
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

export type CreateMcpServerOptions = {
  logger?: FastifyBaseLogger;
};

export function createMcpServer(opts?: CreateMcpServerOptions) {
  const log = opts?.logger ?? createDefaultLogger();
  const server = new McpServer({
    name: 'transcriptor-mcp',
    version,
  });

  /**
   * Get video transcript
   * @param args - Arguments for the tool
   * @returns Transcript
   */
  server.registerTool(
    'get_transcript',
    {
      title: 'Get video transcript',
      description:
        'Fetch cleaned subtitles as plain text for a video (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion).',
      inputSchema: subtitleInputSchema,
      outputSchema: transcriptOutputSchema,
    },
    async (args, _extra) => {
      const { url, lang, type, responseLimit, nextCursor } = resolveSubtitleArgs(args);
      let subtitlesContent = await downloadSubtitles(url, type, lang, log);
      let source: 'youtube' | 'whisper' = 'youtube';
      if (!subtitlesContent) {
        const whisperConfig = getWhisperConfig();
        if (whisperConfig.mode !== 'off') {
          log.info({ url, lang }, 'Trying Whisper fallback');
          subtitlesContent = await transcribeWithWhisper(url, lang, 'srt', log);
          source = 'whisper';
          if (!subtitlesContent) {
            log.warn({ url, lang }, 'Whisper fallback returned no transcript');
          } else {
            log.info({ url, lang }, 'Whisper fallback succeeded');
          }
        } else {
          log.debug({ url }, 'Whisper fallback skipped (mode=off)');
        }
      }
      if (!subtitlesContent) {
        return toolError(`Subtitles not found (${type}, ${lang}).`);
      }

      let plainText: string;
      try {
        plainText = parseSubtitles(subtitlesContent);
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : 'Failed to parse subtitles content.'
        );
      }

      const data = await fetchYtDlpJson(url);
      const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';

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
          ...(source === 'whisper' && { source }),
        },
      };
    }
  );

  /**
   * Get raw video subtitles
   * @param args - Arguments for the tool
   * @returns Raw subtitles
   */
  server.registerTool(
    'get_raw_subtitles',
    {
      title: 'Get raw video subtitles',
      description: 'Fetch raw SRT/VTT subtitles for a video (supported platforms).',
      inputSchema: subtitleInputSchema,
      outputSchema: rawSubtitlesOutputSchema,
    },
    async (args, _extra) => {
      const { url, lang, type, responseLimit, nextCursor } = resolveSubtitleArgs(args);
      let subtitlesContent = await downloadSubtitles(url, type, lang, log);
      let source: 'youtube' | 'whisper' = 'youtube';
      if (!subtitlesContent) {
        const whisperConfig = getWhisperConfig();
        if (whisperConfig.mode !== 'off') {
          log.info({ url, lang }, 'Trying Whisper fallback');
          subtitlesContent = await transcribeWithWhisper(url, lang, 'srt', log);
          source = 'whisper';
          if (!subtitlesContent) {
            log.warn({ url, lang }, 'Whisper fallback returned no transcript');
          } else {
            log.info({ url, lang }, 'Whisper fallback succeeded');
          }
        } else {
          log.debug({ url }, 'Whisper fallback skipped (mode=off)');
        }
      }
      if (!subtitlesContent) {
        return toolError(`Subtitles not found (${type}, ${lang}).`);
      }

      const data = await fetchYtDlpJson(url);
      const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';

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
          ...(source === 'whisper' && { source }),
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
      const url = resolveVideoUrl(args.url);
      if (!url) {
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      const available = await fetchAvailableSubtitles(url);
      if (!available) {
        return toolError('Failed to fetch subtitle availability for this video.');
      }

      const data = await fetchYtDlpJson(url);
      const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';

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
   * Get video info
   * @param args - Arguments for the tool
   * @returns Video info
   */
  server.registerTool(
    'get_video_info',
    {
      title: 'Get video info',
      description:
        'Fetch extended metadata for a video (title, channel, duration, tags, thumbnails, etc.).',
      inputSchema: baseInputSchema,
      outputSchema: videoInfoOutputSchema,
    },
    async (args, _extra) => {
      const url = resolveVideoUrl(args.url);
      if (!url) {
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      const info = await fetchVideoInfo(url);
      if (!info) {
        return toolError('Failed to fetch video info.');
      }

      const videoId = info.id ?? extractVideoId(url) ?? 'unknown';

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
   * Get video chapters
   * @param args - Arguments for the tool
   * @returns Video chapters
   */
  server.registerTool(
    'get_video_chapters',
    {
      title: 'Get video chapters',
      description: 'Fetch chapter markers (start/end time, title) for a video.',
      inputSchema: baseInputSchema,
      outputSchema: videoChaptersOutputSchema,
    },
    async (args, _extra) => {
      const url = resolveVideoUrl(args.url);
      if (!url) {
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      const chapters = await fetchVideoChapters(url);
      if (chapters === null) {
        return toolError('Failed to fetch chapters for this video.');
      }

      const data = await fetchYtDlpJson(url);
      const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';

      const text =
        chapters.length === 0
          ? 'No chapters found.'
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
  const url = resolveVideoUrl(args.url);
  if (!url) {
    throw new Error('Invalid video URL. Use a URL from a supported platform or YouTube video ID.');
  }

  const lang = sanitizeLang(args.lang ?? 'en');
  if (!lang) {
    throw new Error('Invalid language code.');
  }

  const responseLimit = args.response_limit ?? DEFAULT_RESPONSE_LIMIT;
  const nextCursor = args.next_cursor;
  const type = args.type ?? 'auto';

  return { url, lang, responseLimit, nextCursor, type };
}

function resolveVideoUrl(input: string): string | null {
  return normalizeVideoInput(input);
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
