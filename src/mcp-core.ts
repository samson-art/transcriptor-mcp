import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
// IMPORTANT: use Zod v3 schemas for MCP JSON Schema compatibility.
// Some MCP clients (e.g. n8n) are strict about JSON Schema shapes and can fail
// on Zod v4 JSON schema output ($ref-heavy / missing "type" in some branches).
// The MCP SDK already supports Zod v3 via `zod/v3` + `zod-to-json-schema`.
import { z } from 'zod/v3';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import {
  detectSubtitleFormat,
  downloadPlaylistSubtitles,
  formatPlaylistDownloadFailureMessage,
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
import { recordMcpRequestDuration, recordMcpToolCall, recordMcpToolError } from './metrics.js';
import { version } from './version.js';

const TOOL_GET_TRANSCRIPT = 'get_transcript';
const TOOL_GET_RAW_SUBTITLES = 'get_raw_subtitles';
const TOOL_GET_AVAILABLE_SUBTITLES = 'get_available_subtitles';
const TOOL_GET_VIDEO_INFO = 'get_video_info';
const TOOL_GET_VIDEO_CHAPTERS = 'get_video_chapters';
const TOOL_GET_PLAYLIST_TRANSCRIPTS = 'get_playlist_transcripts';
const TOOL_SEARCH_VIDEOS = 'search_videos';

function createDefaultLogger(): FastifyBaseLogger {
  return pino({ level: process.env.LOG_LEVEL || 'info' }) as unknown as FastifyBaseLogger;
}

const MIN_RESPONSE_LIMIT = 1000;

const baseInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'Video URL (supported: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or YouTube video ID'
    ),
  format: z
    .enum(['srt', 'vtt', 'ass', 'lrc'])
    .optional()
    .describe('Subtitle format (default from YT_DLP_SUB_FORMAT or srt)'),
});

const subtitleInputSchema = baseInputSchema.extend({
  type: z
    .enum(['official', 'auto'])
    .optional()
    .describe('Subtitle track type: official or auto-generated'),
  lang: z
    .string()
    .optional()
    .describe(
      'Language code (e.g. en, es). When omitted with Whisper fallback, language is auto-detected'
    ),
  response_limit: z
    .number()
    .int()
    .min(MIN_RESPONSE_LIMIT)
    .optional()
    .describe(
      'Max characters per response. When omitted, returns full content. When set: min 1000'
    ),
  next_cursor: z
    .string()
    .optional()
    .describe('Opaque cursor from previous response for pagination'),
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
  source: z.string().optional(),
});

const rawSubtitlesOutputSchema = z.object({
  videoId: z.string(),
  type: z.enum(['official', 'auto']),
  lang: z.string(),
  format: z.enum(['srt', 'vtt', 'ass', 'lrc']),
  content: z.string(),
  next_cursor: z.string().optional(),
  is_truncated: z.boolean(),
  total_length: z.number(),
  start_offset: z.number(),
  end_offset: z.number(),
  source: z.string().optional(),
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

const playlistTranscriptsInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'Playlist URL (e.g. youtube.com/playlist?list=XXX) or watch URL with list= parameter'
    ),
  type: z
    .enum(['official', 'auto'])
    .optional()
    .describe('Subtitle track type: official or auto-generated (default: auto)'),
  lang: z.string().optional().describe('Language code (e.g. en, ru). Default: en'),
  format: z
    .enum(['srt', 'vtt', 'ass', 'lrc'])
    .optional()
    .describe('Subtitle format (default from YT_DLP_SUB_FORMAT or srt)'),
  playlistItems: z
    .string()
    .optional()
    .describe('yt-dlp -I spec: "1:5", "1,3,7", "-1" for last, "1:10:2" for every 2nd'),
  maxItems: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Max number of videos to fetch (yt-dlp --max-downloads)'),
});

const playlistTranscriptsOutputSchema = z.object({
  results: z.array(
    z.object({
      videoId: z.string(),
      text: z.string(),
    })
  ),
});

const searchInputSchema = z.object({
  query: z.string().optional().describe('Search query'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  offset: z.number().int().min(0).optional().describe('Skip first N results (pagination)'),
  uploadDateFilter: z
    .enum(['hour', 'today', 'week', 'month', 'year'])
    .optional()
    .describe('Filter by upload date (relative to now)'),
  dateBefore: z.string().optional().describe('yt-dlp --datebefore, e.g. "now-1year" or "20241201"'),
  date: z
    .string()
    .optional()
    .describe('yt-dlp --date, exact date e.g. "20231215" or "today-2weeks"'),
  matchFilter: z
    .string()
    .optional()
    .describe('yt-dlp --match-filter, e.g. "!is_live" or "duration < 3600 & like_count > 100"'),
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
type ToolSuccessResult = { content: TextContent[]; structuredContent: Record<string, unknown> };
type ToolErrorResult = { content: TextContent[]; isError: true };
type ToolResult = ToolSuccessResult | ToolErrorResult;

function textContent(text: string): TextContent {
  return { type: 'text', text };
}

function toolError(message: string): ToolErrorResult {
  return {
    content: [textContent(message)],
    isError: true,
  };
}

type WithToolErrorHandlingOptions = {
  /** Custom message for NotFoundError (default: err.message) */
  notFoundMessage?: string;
};

async function withToolErrorHandling(
  toolName: string,
  log: FastifyBaseLogger,
  fn: () => Promise<ToolSuccessResult>,
  options?: WithToolErrorHandlingOptions
): Promise<ToolResult> {
  const start = performance.now();
  try {
    const result = await fn();
    recordMcpToolCall(toolName);
    return result;
  } catch (err) {
    recordMcpToolError(toolName);
    if (err instanceof NotFoundError) {
      return toolError(options?.notFoundMessage ?? err.message);
    }
    if (err instanceof ValidationError) {
      return toolError(err.message);
    }
    log.error({ err, tool: toolName }, 'MCP tool unexpected error');
    return toolError(err instanceof Error ? err.message : 'Tool failed.');
  } finally {
    recordMcpRequestDuration(toolName, (performance.now() - start) / 1000);
  }
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
        'Fetch cleaned subtitles as plain text for a video (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit). Uses auto-discovery for type/language when omitted. Optional: type, lang, response_limit (when omitted returns full transcript), next_cursor for pagination.',
      inputSchema: subtitleInputSchema,
      outputSchema: transcriptOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) =>
      withToolErrorHandling(TOOL_GET_TRANSCRIPT, log, async () => {
        const resolved = resolveSubtitleArgs(args);
        const result = await validateAndDownloadSubtitles(
          {
            url: resolved.url,
            type: resolved.type,
            lang: resolved.lang,
            format: resolved.format,
          },
          log
        );
        let plainText: string;
        try {
          plainText = parseSubtitles(result.subtitlesContent);
        } catch (error) {
          throw new Error(
            error instanceof Error ? error.message : 'Failed to parse subtitles content.',
            { cause: error }
          );
        }
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
            ...(result.source != null && { source: result.source }),
          },
        };
      })
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
        'Fetch raw SRT/VTT subtitles for a video (supported platforms). Optional: type, lang, response_limit (when omitted returns full content), next_cursor for pagination.',
      inputSchema: subtitleInputSchema,
      outputSchema: rawSubtitlesOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) =>
      withToolErrorHandling(TOOL_GET_RAW_SUBTITLES, log, async () => {
        const resolved = resolveSubtitleArgs(args);
        const result = await validateAndDownloadSubtitles(
          {
            url: resolved.url,
            type: resolved.type,
            lang: resolved.lang,
            format: resolved.format,
          },
          log
        );
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
            ...(result.source != null && { source: result.source }),
          },
        };
      })
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
    async (args, _extra) =>
      withToolErrorHandling(
        TOOL_GET_AVAILABLE_SUBTITLES,
        log,
        async () => {
          const url = resolveVideoUrl(args.url);
          if (!url) {
            throw new ValidationError(
              'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
            );
          }
          const result = await validateAndFetchAvailableSubtitles({ url }, log);
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
        },
        { notFoundMessage: 'Failed to fetch subtitle availability for this video.' }
      )
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
    async (args, _extra) =>
      withToolErrorHandling(
        TOOL_GET_VIDEO_INFO,
        log,
        async () => {
          const url = resolveVideoUrl(args.url);
          if (!url) {
            throw new ValidationError(
              'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
            );
          }
          const result = await validateAndFetchVideoInfo({ url }, log);
          const { videoId, info } = result;
          if (!info) {
            throw new Error('Failed to fetch video info.');
          }
          const textLines = [
            info.title ? `Title: ${info.title}` : null,
            info.channel ? `Channel: ${info.channel}` : null,
            info.duration === null ? null : `Duration: ${info.duration}s`,
            info.viewCount === null ? null : `Views: ${info.viewCount}`,
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
        },
        { notFoundMessage: 'Failed to fetch video info.' }
      )
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
    async (args, _extra) =>
      withToolErrorHandling(
        TOOL_GET_VIDEO_CHAPTERS,
        log,
        async () => {
          const url = resolveVideoUrl(args.url);
          if (!url) {
            throw new ValidationError(
              'Invalid video URL. Use a URL from a supported platform or YouTube video ID.'
            );
          }
          const result = await validateAndFetchVideoChapters({ url }, log);
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
        },
        { notFoundMessage: 'Failed to fetch chapters for this video.' }
      )
  );

  /**
   * Get transcripts for multiple videos from a playlist
   */
  server.registerTool(
    'get_playlist_transcripts',
    {
      title: 'Get playlist transcripts',
      description:
        'Fetch cleaned subtitles (plain text) for multiple videos from a playlist. Use playlistItems (e.g. "1:5") to select specific items, maxItems to limit count.',
      inputSchema: playlistTranscriptsInputSchema,
      outputSchema: playlistTranscriptsOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args, _extra) =>
      withToolErrorHandling(TOOL_GET_PLAYLIST_TRANSCRIPTS, log, async () => {
        const url = resolveVideoUrl(args.url);
        if (!url) {
          throw new ValidationError(
            'Invalid URL. Use a playlist URL (e.g. youtube.com/playlist?list=XXX) or watch URL with list= parameter.'
          );
        }

        const lang = args.lang ? (sanitizeLang(args.lang) ?? 'en') : 'en';

        const format =
          args.format && ['srt', 'vtt', 'ass', 'lrc'].includes(args.format)
            ? args.format
            : undefined;

        const outcome = await downloadPlaylistSubtitles(
          url,
          {
            type: args.type ?? 'auto',
            lang,
            format,
            playlistItems: args.playlistItems,
            maxItems: args.maxItems,
          },
          log
        );

        if (!outcome.ok) {
          throw new Error(formatPlaylistDownloadFailureMessage(outcome.failure));
        }

        const rawResults = outcome.results;

        const results = rawResults.map((r) => ({
          videoId: r.videoId,
          text: parseSubtitles(r.content, log),
        }));

        const text =
          results.length === 0
            ? 'No transcripts found.'
            : results.map((r) => `[${r.videoId}]\n${r.text}`).join('\n\n---\n\n');

        return {
          content: [textContent(text)],
          structuredContent: { results },
        };
      })
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
        'Search videos on YouTube via yt-dlp (ytsearch). Returns list of matching videos with metadata. Optional: limit, offset (pagination), uploadDateFilter (hour|today|week|month|year), dateBefore, date, matchFilter (e.g. "!is_live"), response_format (json|markdown).',
      inputSchema: searchInputSchema,
      outputSchema: searchVideosOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (args, _extra) =>
      withToolErrorHandling(TOOL_SEARCH_VIDEOS, log, async () => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          throw new ValidationError('Query is required for search.');
        }

        const limit = args.limit ?? 10;
        const sanitizedLimit = Math.min(Math.max(limit, 1), 50);
        const offset = Math.max(0, args.offset ?? 0);
        const dateAfter = args.uploadDateFilter
          ? UPLOAD_DATE_FILTER_TO_YTDLP[args.uploadDateFilter]
          : undefined;
        const format = args.response_format ?? 'json';

        const results = await searchVideos(query, sanitizedLimit, log, {
          offset: offset > 0 ? offset : undefined,
          dateAfter,
          dateBefore: args.dateBefore,
          date: args.date,
          matchFilter: args.matchFilter,
        });

        if (results === null) {
          throw new Error('Failed to search videos.');
        }

        let text: string;
        if (results.length === 0) {
          text = 'No results found.';
        } else if (format === 'markdown') {
          text = results
            .map(
              (r, i) =>
                `${i + 1}. **${(r.title ?? 'Untitled').replaceAll('**', '')}**\n   Channel: ${r.uploader ?? '—'}\n   Duration: ${r.duration == null ? '—' : r.duration + 's'}\n   URL: ${r.url ?? '—'}${r.viewCount == null ? '' : '\n   Views: ' + r.viewCount}`
            )
            .join('\n\n');
        } else {
          text = results
            .map(
              (r) =>
                `- ${r.title ?? 'Untitled'} (${r.videoId}): ${r.url ?? ''} | ${r.uploader ?? ''} | ${r.viewCount == null ? '' : r.viewCount + ' views'}`
            )
            .join('\n');
        }

        return {
          content: [textContent(text)],
          structuredContent: { results },
        };
      })
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

  server.registerPrompt(
    'search_and_summarize',
    {
      title: 'Search and summarize',
      description:
        'Build a user message that asks the model to search YouTube for videos matching the query, then fetch the transcript for the first result and summarize it.',
      argsSchema: {
        query: z.string().min(1).describe('Search query for YouTube'),
        url: z.string().optional().describe('Optional: use this video URL instead of searching'),
      },
    },
    (args) => {
      const text = args.url
        ? `Use get_transcript to fetch the transcript for this video, then summarize the content. Video URL: ${args.url}`
        : `Use search_videos to find YouTube videos matching "${args.query}", then use get_transcript on the first result and summarize the video content.`;
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    }
  );

  const INFO_URI = 'transcriptor://info';
  server.registerResource(
    'info',
    INFO_URI,
    {
      title: 'Transcriptor MCP Server Information',
      description: 'Information about available Transcriptor MCP resources and how to use them',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: INFO_URI,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              message: 'Transcriptor MCP Server Resources',
              availableResources: {
                info: {
                  description: 'Server information and usage (this document)',
                  uri: 'transcriptor://info',
                },
                transcript: {
                  description: 'Access video transcript by YouTube video ID',
                  uriPattern: 'transcriptor://transcript/{videoId}',
                  example: 'transcriptor://transcript/dQw4w9WgXcQ',
                },
                supportedPlatforms: {
                  description: 'List of supported video platforms',
                  uri: 'transcriptor://docs/supported-platforms',
                },
                usage: {
                  description: 'Brief usage guide for tools',
                  uri: 'transcriptor://docs/usage',
                },
              },
              tools: [
                'get_transcript',
                'get_raw_subtitles',
                'get_available_subtitles',
                'get_video_info',
                'get_video_chapters',
                'get_playlist_transcripts',
                'search_videos',
              ],
              prompts: ['get_transcript_for_video', 'summarize_video', 'search_and_summarize'],
            },
            null,
            2
          ),
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
          text: 'Supported platforms: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit. You can also pass a YouTube video ID directly.',
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
          text: 'Use get_transcript for plain-text subtitles, get_raw_subtitles for SRT/VTT, get_available_subtitles to list languages, get_video_info for metadata, get_video_chapters for chapter markers, get_playlist_transcripts for multiple videos from a playlist, search_videos to search YouTube. URL-based tools accept a video URL or YouTube video ID.',
        },
      ],
    })
  );

  const transcriptTemplate = new ResourceTemplate('transcriptor://transcript/{videoId}', {
    list: undefined,
  });
  server.registerResource(
    'transcript',
    transcriptTemplate,
    {
      title: 'Video transcript',
      description:
        'Get the transcript for a video by YouTube video ID. Use URI format: transcriptor://transcript/{videoId}',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const { videoId } = variables as { videoId: string };
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      const result = await validateAndDownloadSubtitles(
        { url, type: undefined, lang: undefined },
        log
      );
      const plainText = parseSubtitles(result.subtitlesContent);
      const payload = {
        videoId: result.videoId,
        type: result.type,
        lang: result.lang,
        text: plainText,
        ...(result.source != null && { source: result.source }),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
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

  const responseLimit = args.response_limit ?? Infinity;
  const nextCursor = args.next_cursor;
  const format =
    args.format && ['srt', 'vtt', 'ass', 'lrc'].includes(args.format) ? args.format : undefined;

  return { url, type, lang, format, responseLimit, nextCursor };
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
