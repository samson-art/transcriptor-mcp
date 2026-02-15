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
  parseSubtitles,
  searchVideos,
  type VideoChapter,
} from './youtube.js';
import { NotFoundError, ValidationError } from './errors.js';
import {
  normalizeVideoInput,
  sanitizeLang,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
} from './validation.js';
import { recordMcpToolCall, recordMcpToolError } from './metrics.js';
import { version } from './version.js';

const TOOL_GET_TRANSCRIPT = 'get_transcript';
const TOOL_GET_RAW_SUBTITLES = 'get_raw_subtitles';
const TOOL_GET_AVAILABLE_SUBTITLES = 'get_available_subtitles';
const TOOL_GET_VIDEO_INFO = 'get_video_info';
const TOOL_GET_VIDEO_CHAPTERS = 'get_video_chapters';
const TOOL_SEARCH_VIDEOS = 'search_videos';

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
  type: z.enum(['official', 'auto']).optional(),
  lang: z.string().optional(),
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

const UPLOAD_DATE_FILTER_TO_YTDLP: Record<string, string> = {
  hour: 'now-1hour',
  today: 'today',
  week: 'now-1week',
  month: 'now-1month',
  year: 'now-1year',
};

const searchInputSchema = z.object({
  query: z.string().optional().describe('Search query'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  offset: z.number().int().min(0).optional().describe('Skip first N results (pagination)'),
  uploadDateFilter: z
    .enum(['hour', 'today', 'week', 'month', 'year'])
    .optional()
    .describe('Filter by upload date (relative to now)'),
  response_format: z
    .enum(['json', 'markdown'])
    .optional()
    .describe('Format of the human-readable content: json (default) or markdown'),
});

const searchVideosOutputSchema = z.object({
  results: z.array(
    z.object({
      videoId: z.string(),
      title: z.string().nullable(),
      url: z.string().nullable(),
      duration: z.number().nullable(),
      uploader: z.string().nullable(),
      viewCount: z.number().nullable(),
      thumbnail: z.string().nullable(),
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
        'Fetch cleaned subtitles as plain text for a video (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion). Input: URL only. Uses auto-discovery for type/language and returns the first chunk with default size.',
      inputSchema: baseInputSchema,
      outputSchema: transcriptOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) => {
      let resolved: ReturnType<typeof resolveTranscriptArgs>;
      try {
        resolved = resolveTranscriptArgs(args);
      } catch (err) {
        recordMcpToolError(TOOL_GET_TRANSCRIPT);
        return toolError(err instanceof Error ? err.message : 'Invalid request.');
      }

      let result: Awaited<ReturnType<typeof validateAndDownloadSubtitles>>;
      try {
        result = await validateAndDownloadSubtitles(
          { url: resolved.url, type: resolved.type, lang: resolved.lang },
          log
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          recordMcpToolError(TOOL_GET_TRANSCRIPT);
          return toolError(err.message);
        }
        if (err instanceof ValidationError) {
          recordMcpToolError(TOOL_GET_TRANSCRIPT);
          return toolError(err.message);
        }
        log.error({ err, tool: TOOL_GET_TRANSCRIPT }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_GET_TRANSCRIPT);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      let plainText: string;
      try {
        plainText = parseSubtitles(result.subtitlesContent);
      } catch (error) {
        recordMcpToolError(TOOL_GET_TRANSCRIPT);
        return toolError(
          error instanceof Error ? error.message : 'Failed to parse subtitles content.'
        );
      }

      recordMcpToolCall(TOOL_GET_TRANSCRIPT);
      const page = paginateText(plainText, resolved.responseLimit, resolved.nextCursor);
      return {
        content: [textContent(page.chunk)],
        structuredContent: {
          videoId: result.videoId,
          type: result.type,
          lang: result.lang,
          text: page.chunk,
          next_cursor: page.nextCursor,
          is_truncated: page.isTruncated,
          total_length: page.totalLength,
          start_offset: page.startOffset,
          end_offset: page.endOffset,
          ...(result.source === 'whisper' && { source: result.source }),
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
      description:
        'Fetch raw SRT/VTT subtitles for a video (supported platforms). Optional lang: when omitted and Whisper fallback is used, language is auto-detected.',
      inputSchema: subtitleInputSchema,
      outputSchema: rawSubtitlesOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) => {
      let resolved: ReturnType<typeof resolveSubtitleArgs>;
      try {
        resolved = resolveSubtitleArgs(args);
      } catch (err) {
        recordMcpToolError(TOOL_GET_RAW_SUBTITLES);
        return toolError(err instanceof Error ? err.message : 'Invalid request.');
      }

      let result: Awaited<ReturnType<typeof validateAndDownloadSubtitles>>;
      try {
        result = await validateAndDownloadSubtitles(
          { url: resolved.url, type: resolved.type, lang: resolved.lang },
          log
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          recordMcpToolError(TOOL_GET_RAW_SUBTITLES);
          return toolError(err.message);
        }
        if (err instanceof ValidationError) {
          recordMcpToolError(TOOL_GET_RAW_SUBTITLES);
          return toolError(err.message);
        }
        log.error({ err, tool: TOOL_GET_RAW_SUBTITLES }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_GET_RAW_SUBTITLES);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      recordMcpToolCall(TOOL_GET_RAW_SUBTITLES);
      const format = detectSubtitleFormat(result.subtitlesContent);
      const page = paginateText(
        result.subtitlesContent,
        resolved.responseLimit,
        resolved.nextCursor
      );
      return {
        content: [textContent(page.chunk)],
        structuredContent: {
          videoId: result.videoId,
          type: result.type,
          lang: result.lang,
          format,
          content: page.chunk,
          next_cursor: page.nextCursor,
          is_truncated: page.isTruncated,
          total_length: page.totalLength,
          start_offset: page.startOffset,
          end_offset: page.endOffset,
          ...(result.source === 'whisper' && { source: result.source }),
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
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) => {
      const url = resolveVideoUrl(args.url);
      if (!url) {
        recordMcpToolError(TOOL_GET_AVAILABLE_SUBTITLES);
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      let result: Awaited<ReturnType<typeof validateAndFetchAvailableSubtitles>>;
      try {
        result = await validateAndFetchAvailableSubtitles({ url }, log);
      } catch (err) {
        if (err instanceof NotFoundError) {
          recordMcpToolError(TOOL_GET_AVAILABLE_SUBTITLES);
          return toolError('Failed to fetch subtitle availability for this video.');
        }
        if (err instanceof ValidationError) {
          recordMcpToolError(TOOL_GET_AVAILABLE_SUBTITLES);
          return toolError(err.message);
        }
        log.error({ err, tool: TOOL_GET_AVAILABLE_SUBTITLES }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_GET_AVAILABLE_SUBTITLES);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      recordMcpToolCall(TOOL_GET_AVAILABLE_SUBTITLES);
      const text = [
        `Official: ${result.official.length ? result.official.join(', ') : 'none'}`,
        `Auto: ${result.auto.length ? result.auto.join(', ') : 'none'}`,
      ].join('\n');

      return {
        content: [textContent(text)],
        structuredContent: {
          videoId: result.videoId,
          official: result.official,
          auto: result.auto,
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
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) => {
      const url = resolveVideoUrl(args.url);
      if (!url) {
        recordMcpToolError(TOOL_GET_VIDEO_INFO);
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      let result: Awaited<ReturnType<typeof validateAndFetchVideoInfo>>;
      try {
        result = await validateAndFetchVideoInfo({ url }, log);
      } catch (err) {
        if (err instanceof NotFoundError) {
          recordMcpToolError(TOOL_GET_VIDEO_INFO);
          return toolError('Failed to fetch video info.');
        }
        if (err instanceof ValidationError) {
          recordMcpToolError(TOOL_GET_VIDEO_INFO);
          return toolError(err.message);
        }
        log.error({ err, tool: TOOL_GET_VIDEO_INFO }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_GET_VIDEO_INFO);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      const { videoId, info } = result;
      if (!info) {
        recordMcpToolError(TOOL_GET_VIDEO_INFO);
        return toolError('Failed to fetch video info.');
      }
      recordMcpToolCall(TOOL_GET_VIDEO_INFO);
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
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) => {
      const url = resolveVideoUrl(args.url);
      if (!url) {
        recordMcpToolError(TOOL_GET_VIDEO_CHAPTERS);
        return toolError(
          'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
        );
      }

      let result: Awaited<ReturnType<typeof validateAndFetchVideoChapters>>;
      try {
        result = await validateAndFetchVideoChapters({ url }, log);
      } catch (err) {
        if (err instanceof NotFoundError) {
          recordMcpToolError(TOOL_GET_VIDEO_CHAPTERS);
          return toolError('Failed to fetch chapters for this video.');
        }
        if (err instanceof ValidationError) {
          recordMcpToolError(TOOL_GET_VIDEO_CHAPTERS);
          return toolError(err.message);
        }
        log.error({ err, tool: TOOL_GET_VIDEO_CHAPTERS }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_GET_VIDEO_CHAPTERS);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      recordMcpToolCall(TOOL_GET_VIDEO_CHAPTERS);
      const chapters = result.chapters ?? [];
      const text =
        chapters.length === 0
          ? 'No chapters found.'
          : chapters
              .map((ch: VideoChapter) => `${ch.startTime}s - ${ch.endTime}s: ${ch.title}`)
              .join('\n');

      return {
        content: [textContent(text)],
        structuredContent: {
          videoId: result.videoId,
          chapters,
        },
      };
    }
  );

  /**
   * Search videos
   * @param args - Arguments for the tool
   * @returns Search results
   */
  server.registerTool(
    'search_videos',
    {
      title: 'Search videos',
      description:
        'Search videos on YouTube via yt-dlp (ytsearch). Returns list of matching videos with metadata. Optional: limit, offset (pagination), uploadDateFilter (hour|today|week|month|year), response_format (json|markdown).',
      inputSchema: searchInputSchema,
      outputSchema: searchVideosOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (args, _extra) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        recordMcpToolError(TOOL_SEARCH_VIDEOS);
        return toolError('Query is required for search.');
      }

      const limit = args.limit ?? 10;
      const sanitizedLimit = Math.min(Math.max(limit, 1), 50);
      const offset = Math.max(0, args.offset ?? 0);
      const dateAfter = args.uploadDateFilter
        ? UPLOAD_DATE_FILTER_TO_YTDLP[args.uploadDateFilter]
        : undefined;
      const format = args.response_format ?? 'json';

      let results: Awaited<ReturnType<typeof searchVideos>>;
      try {
        results = await searchVideos(query, sanitizedLimit, log, {
          offset: offset > 0 ? offset : undefined,
          dateAfter,
        });
      } catch (err) {
        log.error({ err, tool: TOOL_SEARCH_VIDEOS }, 'MCP tool unexpected error');
        recordMcpToolError(TOOL_SEARCH_VIDEOS);
        return toolError(err instanceof Error ? err.message : 'Tool failed.');
      }

      if (results === null) {
        recordMcpToolError(TOOL_SEARCH_VIDEOS);
        return toolError('Failed to search videos.');
      }

      recordMcpToolCall(TOOL_SEARCH_VIDEOS);
      const text =
        results.length === 0
          ? 'No results found.'
          : format === 'markdown'
            ? results
                .map(
                  (r, i) =>
                    `${i + 1}. **${(r.title ?? 'Untitled').replace(/\*\*/g, '')}**\n   Channel: ${r.uploader ?? '—'}\n   Duration: ${r.duration != null ? `${r.duration}s` : '—'}\n   URL: ${r.url ?? '—'}${r.viewCount != null ? `\n   Views: ${r.viewCount}` : ''}`
                )
                .join('\n\n')
            : results
                .map(
                  (r) =>
                    `- ${r.title ?? 'Untitled'} (${r.videoId}): ${r.url ?? ''} | ${r.uploader ?? ''} | ${r.viewCount != null ? `${r.viewCount} views` : ''}`
                )
                .join('\n');

      return {
        content: [textContent(text)],
        structuredContent: { results },
      };
    }
  );

  const promptUrlArgsSchema = {
    url: z.string().min(1).describe('Video URL or YouTube video ID'),
  };

  server.registerPrompt(
    'get_transcript_for_video',
    {
      title: 'Get transcript for video',
      description:
        'Build a user message that asks the model to fetch the video transcript using the get_transcript tool.',
      argsSchema: promptUrlArgsSchema,
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Fetch the transcript for this video using the get_transcript tool and return the transcript text. Video URL: ${url}`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'summarize_video',
    {
      title: 'Summarize video',
      description:
        'Build a user message that asks the model to fetch the transcript and summarize the video content.',
      argsSchema: promptUrlArgsSchema,
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use get_transcript to fetch the transcript for this video, then summarize the video content in a few sentences. Video URL: ${url}`,
          },
        },
      ],
    })
  );

  const SUPPORTED_PLATFORMS_URI = 'transcriptor://docs/supported-platforms';
  const USAGE_URI = 'transcriptor://docs/usage';

  server.registerResource(
    'supported-platforms',
    SUPPORTED_PLATFORMS_URI,
    {
      description: 'List of supported video platforms for subtitles and transcripts',
      mimeType: 'text/plain',
    },
    () => ({
      contents: [
        {
          uri: SUPPORTED_PLATFORMS_URI,
          mimeType: 'text/plain',
          text: 'Supported platforms: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion. You can also pass a YouTube video ID directly.',
        },
      ],
    })
  );

  server.registerResource(
    'usage',
    USAGE_URI,
    {
      description: 'Brief usage guide for transcriptor-mcp tools',
      mimeType: 'text/plain',
    },
    () => ({
      contents: [
        {
          uri: USAGE_URI,
          mimeType: 'text/plain',
          text: 'Use get_transcript for plain-text subtitles, get_raw_subtitles for SRT/VTT, get_available_subtitles to list languages, get_video_info for metadata, get_video_chapters for chapter markers, search_videos to search YouTube. URL-based tools accept a video URL or YouTube video ID.',
        },
      ],
    })
  );

  return server;
}

function resolveTranscriptArgs(args: { url: string }) {
  const url = resolveVideoUrl(args.url);
  if (!url) {
    throw new Error('Invalid video URL. Use a URL from a supported platform or YouTube video ID.');
  }
  return {
    url,
    type: undefined,
    lang: undefined,
    responseLimit: DEFAULT_RESPONSE_LIMIT,
    nextCursor: undefined,
  };
}

function resolveSubtitleArgs(args: z.infer<typeof subtitleInputSchema>) {
  const url = resolveVideoUrl(args.url);
  if (!url) {
    throw new Error('Invalid video URL. Use a URL from a supported platform or YouTube video ID.');
  }

  const isAutoDiscover = args.type === undefined && args.lang === undefined;

  let type: 'official' | 'auto' | undefined;
  let lang: string | undefined;

  if (isAutoDiscover) {
    type = undefined;
    lang = undefined;
  } else {
    type = args.type ?? 'auto';
    if (args.lang === undefined || args.lang === null) {
      lang = 'en';
    } else {
      const sanitized = sanitizeLang(args.lang);
      if (!sanitized) {
        throw new Error('Invalid language code.');
      }
      lang = sanitized;
    }
  }

  const responseLimit = args.response_limit ?? DEFAULT_RESPONSE_LIMIT;
  const nextCursor = args.next_cursor;

  return { url, type, lang, responseLimit, nextCursor };
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
