import { registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import * as Sentry from '@sentry/node';
import fs from 'node:fs/promises';
import {
  INVALID_LANGUAGE_MESSAGE,
  INVALID_VIDEO_URL_MESSAGE,
  LIST_ANSWER_STEP,
  NotFoundError,
  ServerBusyError,
  UNEXPECTED_ERROR_MESSAGE,
  UNKNOWN_FAILURE_MESSAGE,
  ValidationError,
  YtDlpError,
} from './errors.js';
import { createMcpServer } from './mcp-core.js';
import { renderPrometheus } from './metrics.js';
import * as youtube from './youtube.js';
import * as validation from './validation.js';

jest.mock('@modelcontextprotocol/ext-apps/server', () => ({
  registerAppTool: (
    server: { tools: Map<string, unknown> },
    name: string,
    _def: unknown,
    handler: unknown
  ) => {
    server.tools.set(name, handler);
  },
  registerAppResource: jest.fn(),
  RESOURCE_MIME_TYPE: 'text/html;profile=mcp-app',
}));

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class FakeMcpServer {
    tools = new Map<string, (args: any, extra: any) => any>();
    resources = new Map<string, (...args: any[]) => any>();

    registerTool(name: string, _definition: any, handler: (args: any, extra: any) => any) {
      this.tools.set(name, handler);
    }

    registerPrompt(_name: string, _config: any, _handler: any) {
      // no-op for tests that only exercise tools
    }

    registerResource(
      name: string,
      _uriOrTemplate: string | { uriTemplate: { toString: () => string } },
      _config: any,
      handler: (...args: any[]) => any
    ) {
      this.resources.set(name, handler);
    }
  }

  class FakeResourceTemplate {
    constructor(_uriTemplate: string, _callbacks: { list?: unknown }) {}
  }

  return { McpServer: FakeMcpServer, ResourceTemplate: FakeResourceTemplate };
});

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

jest.mock('./youtube.js', () => ({
  detectSubtitleFormat: jest.fn(),
  downloadPlaylistSubtitles: jest.fn(),
  extractYouTubeVideoId: jest.fn(
    (url: string) => /(?:[?&]v=|youtu\.be\/)([\w-]+)/.exec(url)?.[1] ?? null
  ),
  parseSubtitles: jest.fn(),
  searchVideos: jest.fn(),
}));

jest.mock('./validation.js', () => ({
  // The real ones: the hint's ranking is the behaviour under test, not a stub's.
  preferredTrackOrder:
    jest.requireActual<typeof import('./validation.js')>('./validation.js').preferredTrackOrder,
  sameTrack: jest.requireActual<typeof import('./validation.js')>('./validation.js').sameTrack,
  normalizeVideoInput: jest.fn(),
  sanitizeLang: jest.fn(),
  validateAndDownloadSubtitles: jest.fn(),
  validateAndFetchAvailableSubtitles: jest.fn(),
  validateAndFetchVideoInfo: jest.fn(),
  validateAndFetchVideoChapters: jest.fn(),
  validateAndCaptureVideoFrame: jest.fn(),
  FRAME_MIN_WIDTH: 64,
  FRAME_MAX_WIDTH: 1920,
}));

const captureExceptionMock = Sentry.captureException as unknown as jest.Mock;
const downloadPlaylistSubtitlesMock = youtube.downloadPlaylistSubtitles as jest.Mock;
const detectSubtitleFormatMock = youtube.detectSubtitleFormat as jest.Mock;
const parseSubtitlesMock = youtube.parseSubtitles as jest.Mock;
const searchVideosMock = youtube.searchVideos as jest.Mock;

const normalizeVideoInputMock = validation.normalizeVideoInput as jest.Mock;
const sanitizeLangMock = validation.sanitizeLang as jest.Mock;
const validateAndDownloadSubtitlesMock = validation.validateAndDownloadSubtitles as jest.Mock;
const validateAndFetchAvailableSubtitlesMock =
  validation.validateAndFetchAvailableSubtitles as jest.Mock;
const validateAndFetchVideoInfoMock = validation.validateAndFetchVideoInfo as jest.Mock;
const validateAndFetchVideoChaptersMock = validation.validateAndFetchVideoChapters as jest.Mock;
const validateAndCaptureVideoFrameMock = validation.validateAndCaptureVideoFrame as jest.Mock;

function getTool(server: any, name: string) {
  const handler = server.tools.get(name);
  if (!handler) {
    throw new Error(`Tool ${name} is not registered`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return handler;
}

describe('mcp-core tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Use case: Search and transcript', () => {
    it('search_videos returns results, get_transcript with url from first result returns text', async () => {
      const server = createMcpServer() as any;
      const searchHandler = getTool(server, 'search_videos');
      const transcriptHandler = getTool(server, 'get_transcript');

      const mockResults = [
        {
          videoId: 'vid1',
          title: 'React Hooks Tutorial',
          url: 'https://www.youtube.com/watch?v=vid1',
          duration: 600,
          uploader: 'Dev Channel',
          viewCount: 5000,
          thumbnail: null,
        },
      ];
      searchVideosMock.mockResolvedValue(mockResults);

      const searchResult = await searchHandler({ query: 'react hooks tutorial', limit: 5 }, {});

      expect(searchResult.structuredContent.results).toEqual(mockResults);
      const firstVideoUrl = mockResults[0].url;

      normalizeVideoInputMock.mockReturnValue(firstVideoUrl);
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'vid1',
        type: 'auto',
        lang: 'en',
        subtitlesContent: '1\n00:00:00,000 --> 00:00:05,000\nIntroduction to hooks',
        source: 'youtube',
      });
      parseSubtitlesMock.mockReturnValue('Introduction to hooks');

      const transcriptResult = await transcriptHandler({ url: firstVideoUrl }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        { url: firstVideoUrl, type: undefined, lang: undefined },
        expect.anything()
      );
      expect(transcriptResult.structuredContent).toMatchObject({
        videoId: 'vid1',
        text: 'Introduction to hooks',
      });
    });
  });

  describe('Use case: Pagination for long transcripts', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';
    const longContent = 'abcdefghij'; // 10 chars, response_limit 6

    it('get_raw_subtitles returns next_cursor; second call with next_cursor returns next chunk', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_raw_subtitles');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'official',
        lang: 'en',
        subtitlesContent: longContent,
      });
      detectSubtitleFormatMock.mockReturnValue('srt');

      const first = await handler(
        { url: testUrl, type: 'official', lang: 'en', response_limit: 6 },
        {}
      );

      expect(first.structuredContent).toMatchObject({
        content: 'abcdef',
        is_truncated: true,
        total_length: 10,
        start_offset: 0,
        end_offset: 6,
        next_cursor: '6',
      });

      const second = await handler(
        { url: testUrl, type: 'official', lang: 'en', response_limit: 6, next_cursor: '6' },
        {}
      );

      expect(second.structuredContent).toMatchObject({
        content: 'ghij',
        is_truncated: false,
        total_length: 10,
        start_offset: 6,
        end_offset: 10,
      });
      expect(second.structuredContent.next_cursor).toBeUndefined();
    });
  });

  describe('get_transcript', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return paginated transcript on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: 'subtitle content',
        source: 'youtube',
      });
      parseSubtitlesMock.mockReturnValue('abcdefghij'); // 10 chars, below default limit

      // A bare id in, the resolved page out: tells `url` from the raw argument.
      const result = await handler({ url: 'video123' }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        { url: testUrl, type: undefined, lang: undefined },
        expect.anything()
      );
      expect(parseSubtitlesMock).toHaveBeenCalledWith('subtitle content');

      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
        url: testUrl,
        type: 'auto',
        lang: 'en',
        text: 'abcdefghij',
        is_truncated: false,
        total_length: 10,
        start_offset: 0,
        end_offset: 10,
      });
      expect(result.content[0]).toEqual({ type: 'text', text: 'abcdefghij' });
    });

    it('should return error when subtitles are not found', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError('No auto subtitles available for language "en"', 'Subtitles not found')
      );

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('No auto subtitles available');
    });

    it('should report a parse failure and answer with a safe line', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: 'subtitle content',
      });
      parseSubtitlesMock.mockImplementation(() => {
        throw new Error('parse error');
      });

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(UNEXPECTED_ERROR_MESSAGE);
      expect(captureExceptionMock).toHaveBeenCalled();
    });

    it('should return transcript with source whisper when validation returns whisper', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: '1\n00:00:00,000 --> 00:00:01,000\nAuto-detected transcript',
        source: 'whisper',
      });
      parseSubtitlesMock.mockReturnValue('Auto-detected transcript');

      const result = await handler({ url: testUrl }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        { url: testUrl, type: undefined, lang: undefined },
        expect.anything()
      );
      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
        lang: 'en',
        source: 'whisper',
      });
    });
  });

  describe('get_raw_subtitles', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return raw subtitles with format and pagination', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_raw_subtitles');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'official',
        lang: 'en',
        subtitlesContent: 'abcdefghij',
      });
      detectSubtitleFormatMock.mockReturnValue('srt');

      const result = await handler(
        { url: testUrl, type: 'official', lang: 'en', response_limit: 6 },
        {}
      );

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        { url: testUrl, type: 'official', lang: 'en' },
        expect.anything()
      );
      expect(detectSubtitleFormatMock).toHaveBeenCalledWith('abcdefghij');

      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
        type: 'official',
        lang: 'en',
        format: 'srt',
        content: 'abcdef',
        is_truncated: true,
        total_length: 10,
        start_offset: 0,
        end_offset: 6,
        next_cursor: '6',
      });
    });
  });

  describe('tools requiring video URL', () => {
    it('return error when normalizeVideoInput returns null', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(null);

      const avail = await getTool(server, 'get_available_subtitles')({ url: 'invalid' }, {});
      const info = await getTool(server, 'get_video_info')({ url: 'invalid' }, {});
      const chapters = await getTool(server, 'get_video_chapters')({ url: 'invalid' }, {});

      for (const result of [avail, info, chapters]) {
        expect(result).toMatchObject({ isError: true });
        expect(result.content[0].text).toContain('Invalid video URL');
      }
      expect(validateAndFetchAvailableSubtitlesMock).not.toHaveBeenCalled();
      expect(validateAndFetchVideoInfoMock).not.toHaveBeenCalled();
      expect(validateAndFetchVideoChaptersMock).not.toHaveBeenCalled();
    });
  });

  describe('get_available_subtitles', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return structured list of subtitles', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_available_subtitles');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchAvailableSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        official: ['en', 'ru'],
        auto: ['en'],
      });

      const result = await handler({ url: 'video123' }, {});

      expect(validateAndFetchAvailableSubtitlesMock).toHaveBeenCalledWith(
        { url: testUrl },
        expect.anything()
      );
      expect(result.structuredContent).toEqual({
        videoId: 'video123',
        official: ['en', 'ru'],
        auto: ['en'],
      });
      expect(result.content[0].text).toContain('Official: en, ru');
      expect(result.content[0].text).toContain('Auto: en');
    });
  });

  describe('get_video_info', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return error when video info cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoInfoMock.mockRejectedValue(
        new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found')
      );

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      // The tool used to answer with 'Failed to fetch video info.' whatever the layer
      // below said. Pinned exactly, because the fact under test is "nobody rewrites it".
      expect(result.content[0].text).toBe(UNKNOWN_FAILURE_MESSAGE);
    });

    it('should log and return error when video info fetch throws unexpected error', async () => {
      const logger: {
        error: jest.Mock;
        info: jest.Mock;
        debug: jest.Mock;
        warn: jest.Mock;
        child: jest.Mock;
      } = {
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        child: jest.fn(),
      };
      logger.child.mockReturnValue(logger);
      const server = createMcpServer({ logger: logger as any }) as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      const errMsg =
        "EACCES: permission denied, copyfile '/cookies/cookies.txt' -> '/tmp/cookies_xxx.txt'";
      validateAndFetchVideoInfoMock.mockRejectedValue(new Error(errMsg));

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      // The raw message holds a cookies path: the caller gets a fixed sentence. Written out,
      // because REST shares the constant and the tool text must not change with it.
      expect(result.content[0].text).toBe(
        'Internal server error (a fault in this server, not in your request). Retry once; if it fails again, do not retry — tell the user this cannot be completed right now.'
      );
      expect(result.content[0].text).not.toContain('/cookies');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), tool: 'get_video_info' }),
        'MCP tool unexpected error'
      );
      expect(captureExceptionMock).toHaveBeenCalled();
    });

    it('should answer a playlist failure with the classified sentence', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_playlist_transcripts');

      normalizeVideoInputMock.mockReturnValue('https://www.youtube.com/playlist?list=PLxxx');
      downloadPlaylistSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));

      const result = await handler(
        { url: 'https://www.youtube.com/playlist?list=PLxxx', lang: 'en' },
        {}
      );

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(
        'The platform is rate-limiting this server right now. Most requests to this platform keep failing while the limit lasts, and it can last hours: do not retry this request. Videos on other platforms are not affected.'
      );
    });

    it('should write one log line per call with hashed address, source and outcome', async () => {
      const logger = {
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        child: jest.fn(),
      };
      logger.child.mockReturnValue(logger);
      const server = createMcpServer({ logger: logger as any }) as any;
      const handler = getTool(server, 'get_video_info');
      normalizeVideoInputMock.mockReturnValue(testUrl);

      validateAndFetchVideoInfoMock.mockRejectedValue(new YtDlpError('private'));
      await handler({ url: testUrl }, { _meta: { 'transcriptor/source': 'widget' } });
      validateAndFetchVideoInfoMock.mockRejectedValue(new YtDlpError('private'));
      await handler({ url: testUrl, lang: 'en' }, {});

      const lines = (logger.warn.mock.calls as Array<[Record<string, unknown>, string]>)
        .filter((c) => c[1] === 'MCP tool call')
        .map((c) => c[0]);
      expect(lines).toEqual([
        expect.objectContaining({
          tool: 'get_video_info',
          outcome: 'error',
          reason: 'private',
          platform: 'youtube',
          host: 'www.youtube.com',
          explicit: false,
          addr: expect.stringMatching(/^[0-9a-f]{12}$/),
          vid: expect.stringMatching(/^[0-9a-f]{12}$/),
          source: 'widget',
        }),
        expect.objectContaining({ explicit: true, source: 'model' }),
      ]);
      expect(lines[0].addr).toBe(lines[1].addr);

      // Two spellings of one video: different addresses, one video.
      logger.warn.mockClear();
      const short = 'https://youtu.be/video123';
      normalizeVideoInputMock.mockReturnValue(short);
      validateAndFetchVideoInfoMock.mockRejectedValue(new YtDlpError('private'));
      await handler({ url: short }, {});
      const viaShortLink = (logger.warn.mock.calls as Array<[Record<string, unknown>, string]>)
        .filter((c) => c[1] === 'MCP tool call')
        .map((c) => c[0])[0];
      expect(viaShortLink.addr).not.toBe(lines[0].addr);
      expect(viaShortLink.vid).toBe(lines[0].vid);
      normalizeVideoInputMock.mockReturnValue(testUrl);

      // A link without https:// is rejected: it must not look like a bare video id.
      logger.warn.mockClear();
      normalizeVideoInputMock.mockReturnValue(null);
      await handler({ url: 'youtube.com/watch?v=video123' }, {});
      await handler({ url: 'rick astley' }, {});
      const hosts = (logger.warn.mock.calls as Array<[Record<string, unknown>, string]>)
        .filter((c) => c[1] === 'MCP tool call')
        .map((c) => c[0].host);
      expect(hosts).toEqual(['no_scheme:youtube.com', 'invalid']);
      expect(JSON.stringify(lines)).not.toContain('youtube.com/watch');

      const metrics = await renderPrometheus();
      expect(metrics).toMatch(
        /mcp_request_duration_seconds_count\{[^}]*endpoint="get_video_info",outcome="error"[^}]*\} [1-9]/
      );
      expect(metrics).toMatch(/mcp_tool_calls_total\{[^}]*tool="get_video_info"[^}]*\} [1-9]/);
    });

    it('should answer a busy server with a retry line and no error log', async () => {
      const logger = {
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        child: jest.fn(),
      };
      logger.child.mockReturnValue(logger);
      const server = createMcpServer({ logger: logger as any }) as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoInfoMock.mockRejectedValue(new ServerBusyError());

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe('The server is busy, try again in a moment.');
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should answer a classified yt-dlp failure with its own sentence', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoInfoMock.mockRejectedValue(new YtDlpError('bot_check'));

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('bot detection');
    });

    it('should return structured video info on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);

      const info = {
        id: 'video123',
        title: 'Test title',
        uploader: 'Uploader',
        uploaderId: 'uploader123',
        channel: 'Channel',
        channelId: 'channel123',
        channelUrl: 'https://example.com/channel',
        duration: 120,
        description: 'Description',
        uploadDate: '2025-01-01',
        webpageUrl: 'https://example.com/watch?v=video123',
        viewCount: 42,
        likeCount: 5,
        commentCount: null,
        tags: null,
        categories: null,
        liveStatus: null,
        isLive: null,
        wasLive: null,
        availability: null,
        thumbnail: null,
        thumbnails: null,
      };

      validateAndFetchVideoInfoMock.mockResolvedValue({ videoId: 'video123', info });

      const result = await handler({ url: testUrl }, {});

      expect(validateAndFetchVideoInfoMock).toHaveBeenCalledWith(
        { url: testUrl },
        expect.anything()
      );
      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
        title: info.title,
        uploader: info.uploader,
        duration: info.duration,
        viewCount: info.viewCount,
        likeCount: info.likeCount,
      });
      expect(result.content[0].text).toContain('Title: Test title');
      expect(result.content[0].text).toContain('Channel: Channel');
      expect(result.content[0].text).toContain('Duration: 120s');
      expect(result.content[0].text).toContain('Views: 42');
      expect(result.content[0].text).toContain('URL: https://example.com/watch?v=video123');
    });
  });

  describe('resource reads', () => {
    const PATH_ERROR =
      "EACCES: permission denied, copyfile '/cookies/cookies.txt' -> '/tmp/cookies_xxx.txt'";
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

    // The SDK answers a failed read with the thrown message, so the caller would see it.
    it('answer an unplanned error with the generic text, and log and report the real one', async () => {
      validateAndDownloadSubtitlesMock.mockRejectedValue(new Error(PATH_ERROR));
      const server = createMcpServer({ logger: logger as any }) as any;
      const read = server.resources.get('transcript');

      await expect(
        read(new URL('transcriptor://transcript/abc'), { videoId: 'abc' })
      ).rejects.toThrow(new Error(UNEXPECTED_ERROR_MESSAGE));
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ message: PATH_ERROR }),
          resource: 'transcriptor://transcript',
        }),
        'MCP tool unexpected error'
      );
      expect(captureExceptionMock).toHaveBeenCalled();
    });

    it('keep the text of a planned error', async () => {
      validateAndDownloadSubtitlesMock.mockRejectedValue(new NotFoundError('No subtitles.'));
      const server = createMcpServer({ logger: logger as any }) as any;
      const read = server.resources.get('transcript');

      await expect(
        read(new URL('transcriptor://transcript/abc'), { videoId: 'abc' })
      ).rejects.toThrow(new Error('No subtitles.'));
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    // Runs before 'widget resources' below, which fills the module's HTML cache.
    it('answer a missing widget file with the generic text, not its path', async () => {
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockRejectedValue(
          new Error("ENOENT: no such file or directory, open '/srv/dist/ui/x.html'")
        );
      createMcpServer({ logger: logger as any });
      const reads = (registerAppResource as jest.Mock).mock.calls.map(
        (call) => call[4] as () => Promise<unknown>
      );
      expect(reads).toHaveLength(4);

      for (const read of reads) {
        await expect(read()).rejects.toThrow(new Error(UNEXPECTED_ERROR_MESSAGE));
      }
      readFile.mockRestore();
    });
  });

  describe('widget resources', () => {
    it('declare one thumbnail policy in both the spec and ChatGPT dialects', async () => {
      // ChatGPT reads only openai/widgetCSP; with ui.csp alone it applies no policy.
      const readFile = jest.spyOn(fs, 'readFile').mockResolvedValue('<html></html>');
      createMcpServer();
      type ReadResource = () => Promise<{ contents: Array<{ _meta: Record<string, any> }> }>;
      const reads = (registerAppResource as jest.Mock).mock.calls.map(
        (call) => call[4] as ReadResource
      );
      expect(reads).toHaveLength(4);

      for (const read of reads) {
        const { contents } = await read();
        const meta = contents[0]._meta;
        expect(meta.ui.csp.resourceDomains).toContain('https://*.cdninstagram.com');
        expect(meta['openai/widgetCSP']).toEqual({
          connect_domains: [],
          resource_domains: meta.ui.csp.resourceDomains,
        });
      }
      readFile.mockRestore();
    });
  });

  describe('get_video_chapters', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return error when chapters cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoChaptersMock.mockRejectedValue(
        new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found')
      );

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(UNKNOWN_FAILURE_MESSAGE);
    });

    it('should return structured chapters on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);

      const chapters = [
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ];
      validateAndFetchVideoChaptersMock.mockResolvedValue({
        videoId: 'video123',
        chapters,
      });

      const result = await handler({ url: testUrl }, {});

      expect(validateAndFetchVideoChaptersMock).toHaveBeenCalledWith(
        { url: testUrl },
        expect.anything()
      );
      expect(result.structuredContent).toEqual({
        videoId: 'video123',
        chapters,
      });
      expect(result.content[0].text).toContain('0s - 60s: Intro');
      expect(result.content[0].text).toContain('60s - 120s: Main');
    });

    it('should return empty chapters message when no chapters found', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoChaptersMock.mockResolvedValue({
        videoId: 'video123',
        chapters: [],
      });

      const result = await handler({ url: 'video123' }, {});

      expect(validateAndFetchVideoChaptersMock).toHaveBeenCalledWith(
        { url: testUrl },
        expect.anything()
      );
      expect(result.structuredContent).toEqual({
        videoId: 'video123',
        chapters: [],
      });
      expect(result.content[0].text).toContain('No chapters found');
    });
  });

  describe('get_video_frame', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return image content and structured metadata on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_frame');

      const frameData = Buffer.from('fake-jpeg-bytes');
      validateAndCaptureVideoFrameMock.mockResolvedValue({
        videoId: 'video123',
        url: testUrl,
        timestampSeconds: 83.5,
        timestamp: '00:01:23.500',
        mimeType: 'image/jpeg',
        sizeBytes: frameData.length,
        width: 1280,
        data: frameData,
      });

      const result = await handler({ url: testUrl, timecode: '01:23.500' }, {});

      expect(validateAndCaptureVideoFrameMock).toHaveBeenCalledWith(
        {
          url: testUrl,
          timecode: '01:23.500',
          seconds: undefined,
          format: undefined,
          width: undefined,
          quality: undefined,
        },
        expect.anything()
      );
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Frame captured at 00:01:23.500',
      });
      expect(result.content[1]).toEqual({
        type: 'image',
        data: frameData.toString('base64'),
        mimeType: 'image/jpeg',
      });
      expect(result.structuredContent).toEqual({
        videoId: 'video123',
        url: testUrl,
        timestampSeconds: 83.5,
        timestamp: '00:01:23.500',
        mimeType: 'image/jpeg',
        sizeBytes: frameData.length,
        width: 1280,
      });
    });

    it('should return validation error message for invalid timestamp input', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_frame');

      validateAndCaptureVideoFrameMock.mockRejectedValue(
        new ValidationError('Provide either timecode or seconds, not both', 'Invalid timestamp')
      );

      const result = await handler({ url: testUrl, timecode: '01:23', seconds: 83 }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Provide either timecode or seconds');
    });

    it('should pass the capture failure text through unchanged', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_frame');
      const thrown =
        'Could not capture a frame at 00:00:10.000: the server could not read the video stream.';

      validateAndCaptureVideoFrameMock.mockRejectedValue(
        new NotFoundError(thrown, 'Frame capture failed')
      );

      const result = await handler({ url: testUrl }, {});

      expect(result).toMatchObject({ isError: true });
      // Exact: the timestamp is the only thing that tells the caller which retry is worth
      // making, and the tool's own sentence never had it.
      expect(result.content[0].text).toBe(thrown);
    });
  });

  describe('search_videos', () => {
    it('should return error when query is empty or omitted', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      const result1 = await handler({}, {});
      expect(result1).toMatchObject({ isError: true });
      expect(result1.content[0].text).toContain('Query is required');

      const result2 = await handler({ query: '' }, {});
      expect(result2).toMatchObject({ isError: true });
      expect(result2.content[0].text).toContain('Query is required');

      const result3 = await handler({ query: '   ' }, {});
      expect(result3).toMatchObject({ isError: true });
      expect(result3.content[0].text).toContain('Query is required');

      expect(searchVideosMock).not.toHaveBeenCalled();
    });

    it('should call searchVideos and return results on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      const mockResults = [
        {
          videoId: 'vid1',
          title: 'Video One',
          url: 'https://www.youtube.com/watch?v=vid1',
          duration: 120,
          uploader: 'Channel One',
          viewCount: 1000,
          thumbnail: null,
        },
      ];
      searchVideosMock.mockResolvedValue(mockResults);

      const result = await handler({ query: 'test query', limit: 10 }, {});

      expect(searchVideosMock).toHaveBeenCalledWith(
        'test query',
        10,
        expect.anything(),
        expect.any(Object)
      );
      expect(result.structuredContent).toEqual({ results: mockResults });
      expect(result.content[0].text).toContain('Video One');
      expect(result.content[0].text).toContain('vid1');
      expect(result.content[0].text).toContain('Channel One');
    });

    it('should use default limit 10 when limit not provided', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      searchVideosMock.mockResolvedValue([]);

      await handler({ query: 'test' }, {});

      expect(searchVideosMock).toHaveBeenCalledWith(
        'test',
        10,
        expect.anything(),
        expect.any(Object)
      );
    });

    it('should pass offset and uploadDateFilter to searchVideos', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      searchVideosMock.mockResolvedValue([]);

      await handler({ query: 'react hooks', limit: 5, offset: 10, uploadDateFilter: 'week' }, {});

      expect(searchVideosMock).toHaveBeenCalledWith(
        'react hooks',
        5,
        expect.anything(),
        expect.objectContaining({ offset: 10, dateAfter: 'now-1week' })
      );
    });

    it('should return markdown-formatted content when response_format is markdown', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      const mockResults = [
        {
          videoId: 'ab1',
          title: 'First Video',
          url: 'https://www.youtube.com/watch?v=ab1',
          duration: 300,
          uploader: 'Dev Channel',
          viewCount: 5000,
          thumbnail: null,
        },
      ];
      searchVideosMock.mockResolvedValue(mockResults);

      const result = await handler(
        { query: 'tutorial', limit: 10, response_format: 'markdown' },
        {}
      );

      expect(result.content[0].text).toContain('**First Video**');
      expect(result.content[0].text).toContain('Channel: Dev Channel');
      expect(result.content[0].text).toContain('URL: https://www.youtube.com/watch?v=ab1');
    });

    it('should return error when searchVideos returns null', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      searchVideosMock.mockResolvedValue(null);

      const result = await handler({ query: 'test' }, {});

      expect(result).toMatchObject({ isError: true });
      const text = result.content[0].text;
      expect(text).toContain('The search failed');
      expect(text).toContain('matchFilter');
      expect(text).toContain('dateBefore');
      expect(text).toMatch(/retry once/i);
    });

    it('should return No results found when search returns empty array', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'search_videos');

      searchVideosMock.mockResolvedValue([]);

      const result = await handler({ query: 'test' }, {});

      expect(result.structuredContent).toEqual({ results: [] });
      expect(result.content[0].text).toContain('No results found');
    });
  });

  describe('error texts the caller has to act on', () => {
    const transcriptArgs = { url: 'https://www.youtube.com/watch?v=video123' };

    it('answers a bad URL with the supported platforms', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(null);

      const result = await getTool(server, 'get_video_info')({ url: 'rick astley' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(INVALID_VIDEO_URL_MESSAGE);
    });

    it('keeps the playlist tool on its own sentence about playlists', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(null);

      const result = await getTool(server, 'get_playlist_transcripts')({ url: 'nope' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toMatch(/playlist/i);
      expect(result.content[0].text).toContain('list=');
      expect(downloadPlaylistSubtitlesMock).not.toHaveBeenCalled();
    });

    it('appends the tracks the video does have, best guesses first', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      sanitizeLangMock.mockImplementation((lang: string) => lang);
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError('No auto subtitles could be downloaded for language "de".', 'x', {
          official: ['en'],
          auto: ['ar', 'de', 'de-AT', 'en', 'ru-orig', 'zu'],
          tried: { type: 'auto', lang: 'de' },
        })
      );

      const result = await getTool(server, 'get_transcript')(
        { ...transcriptArgs, type: 'auto', lang: 'de' },
        {}
      );

      const text = result.content[0].text as string;
      expect(text).toContain('No auto subtitles could be downloaded');
      expect(text).toContain('official: en;');
      const autoCodes = /auto: ([^.]+)\./.exec(text)?.[1].split(', ');
      // -orig first (it is the audio's own track), then the rest of the language the caller
      // asked for, then en. The track that just came back empty goes last.
      expect(autoCodes).toEqual(['ru-orig', 'de-AT', 'en', 'ar', 'zu', 'de']);
    });

    it('puts the track that just came back empty last, under both of its names', async () => {
      // YouTube lists its speech track as `en` and `en-orig`, with one URL.
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError('The server asked for the auto track "en-orig" and got no text.', 'x', {
          official: ['de', 'en'],
          auto: ['ab', 'ar', 'de', 'en', 'en-orig', 'fr', 'ru'],
          tried: { type: 'auto', lang: 'en-orig' },
        })
      );

      const result = await getTool(server, 'get_transcript')(transcriptArgs, {});

      const text = result.content[0].text as string;
      expect(/auto: ([^.]+)\./.exec(text)?.[1].split(', ')).toEqual([
        'ab',
        'ar',
        'de',
        'fr',
        'ru',
        'en-orig',
        'en',
      ]);
      // Another type is another track: the official en is still the best guess there.
      expect(text).toContain('official: en, de;');
    });

    it('cuts the track list and says where the rest is', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      const many = Array.from({ length: 20 }, (_, i) => `l${String(i).padStart(2, '0')}`);
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError('none', 'x', { official: [], auto: many })
      );

      const result = await getTool(server, 'get_transcript')(transcriptArgs, {});

      const text = result.content[0].text as string;
      expect(text).toContain('official: none;');
      expect(text).toContain('+5 more');
      expect(text).toContain('get_available_subtitles');
    });

    it('adds no track list when the video has no tracks', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError('The platform lists no subtitle tracks for this video.', 'x', {
          official: [],
          auto: [],
        })
      );

      const result = await getTool(server, 'get_transcript')(transcriptArgs, {});

      expect(result.content[0].text).not.toContain('Available tracks');
    });

    it('passes the availability tool the reason it was given', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      validateAndFetchAvailableSubtitlesMock.mockRejectedValue(
        new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found')
      );

      const result = await getTool(server, 'get_available_subtitles')(transcriptArgs, {});

      // This override had no test at all: deleting it was the one change nothing made red.
      expect(result.content[0].text).toBe(UNKNOWN_FAILURE_MESSAGE);
    });

    it('rejects a bad URL before it looks at the language', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(null);
      sanitizeLangMock.mockReturnValue(null);

      const result = await getTool(server, 'get_transcript')({ url: 'nope', lang: '!!' }, {});

      expect(result.content[0].text).toBe(INVALID_VIDEO_URL_MESSAGE);
    });

    it('tells a bad cursor how long the text is, and accepts one at the end of it', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      sanitizeLangMock.mockImplementation((lang: string) => lang);
      validateAndDownloadSubtitlesMock.mockResolvedValue({
        videoId: 'video123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: 'raw',
      });
      parseSubtitlesMock.mockReturnValue('0123456789');
      const past = await getTool(server, 'get_transcript')(
        { ...transcriptArgs, next_cursor: '99' },
        {}
      );
      expect(past).toMatchObject({ isError: true });
      expect(past.content[0].text).toContain('10 characters long');
      expect(past.content[0].text).toContain('next_cursor');

      // Naming the length puts a hand on this boundary; `>=` would turn a legitimate
      // end-of-text cursor into an error.
      const atEnd = await getTool(server, 'get_transcript')(
        { ...transcriptArgs, next_cursor: '10' },
        {}
      );
      expect(atEnd.isError).toBeFalsy();
      expect(atEnd.structuredContent).toMatchObject({ text: '', total_length: 10 });
    });

    it('reports the type and lang an empty playlist actually used', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue('https://www.youtube.com/playlist?list=PL1');
      sanitizeLangMock.mockReturnValue('de');
      downloadPlaylistSubtitlesMock.mockResolvedValue([]);

      const result = await getTool(server, 'get_playlist_transcripts')(
        { url: 'PL1', lang: ' de ' },
        {}
      );

      const text = result.content[0].text as string;
      expect(text).toContain('type "auto"');
      expect(text).toContain('lang "de"');
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ results: [] });
    });

    it('refuses a playlist lang it cannot use, instead of asking for English', async () => {
      // One run spends a caption request per video: a lang nobody asked for costs them all.
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue('https://www.youtube.com/playlist?list=PL1');
      sanitizeLangMock.mockReturnValue(null);

      const result = await getTool(server, 'get_playlist_transcripts')(
        { url: 'PL1', lang: 'zz!!' },
        {}
      );

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(INVALID_LANGUAGE_MESSAGE);
      expect(downloadPlaylistSubtitlesMock).not.toHaveBeenCalled();
    });

    it('masks an internal fault instead of answering 404 for it', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(transcriptArgs.url);
      // The dead `if (!info)` guard used to turn this into a 404 "Failed to fetch video
      // info."; the layer below throws on a missing info, so this shape is a real fault.
      validateAndFetchVideoInfoMock.mockResolvedValue({ videoId: 'video123', info: null });

      const result = await getTool(server, 'get_video_info')(transcriptArgs, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Internal server error');
      expect(captureExceptionMock).toHaveBeenCalled();
    });
  });

  describe('an omitted lang means the original language', () => {
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL1';

    it('lets the server pick the track when only type is given', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue('https://www.youtube.com/watch?v=video123');

      await getTool(server, 'get_transcript')({ url: 'video123', type: 'official' }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'official', lang: undefined }),
        expect.anything()
      );
    });

    it('leaves the type to the service when only lang is given, so its answer can say so', async () => {
      // The service defaults it to auto and says so in a "no subtitles" answer; a default
      // filled in here hides that sentence from every MCP caller.
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue('https://www.youtube.com/watch?v=video123');
      validateAndDownloadSubtitlesMock.mockRejectedValue(new NotFoundError('none'));

      await getTool(server, 'get_transcript')({ url: 'video123', lang: 'ru' }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: undefined, lang: 'ru' }),
        expect.anything()
      );
    });

    it('asks for lang on a playlist without one, before any run', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(playlistUrl);

      const result = await getTool(server, 'get_playlist_transcripts')({ url: 'PL1' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Pass lang');
      expect(downloadPlaylistSubtitlesMock).not.toHaveBeenCalled();
    });

    it('names the tracks when the transcript resource gets the list answer', async () => {
      const server = createMcpServer() as any;
      validateAndDownloadSubtitlesMock.mockRejectedValue(
        new NotFoundError(
          `The platform does not say which language… ${LIST_ANSWER_STEP}`,
          'Subtitles not found',
          { official: ['en', 'es'], auto: [] }
        )
      );

      const read = server.resources.get('transcript')(new URL('transcriptor://transcript/abc'), {
        videoId: 'abc',
      });

      await expect(read).rejects.toThrow(/Available tracks — official: en, es.*get_transcript/);
    });

    it('points the transcript resource to get_transcript only where type and lang would help', async () => {
      // A second next step next to "do not repeat" or "retry in a few minutes" contradicts it.
      const server = createMcpServer() as any;
      for (const message of [
        'The server asked for the official track "en" and got no text. Do not repeat the same call.',
        'Speech-to-text was also tried and produced nothing. You may retry the same call once in a few minutes; if it fails again, do not retry.',
      ]) {
        validateAndDownloadSubtitlesMock.mockRejectedValue(
          new NotFoundError(message, 'Subtitles not found', { official: ['en'], auto: [] })
        );
        const read = server.resources.get('transcript')(new URL('transcriptor://transcript/abc'), {
          videoId: 'abc',
        });
        await expect(read).rejects.toThrow(message);
        await expect(read).rejects.not.toThrow(/get_transcript/);
      }
    });

    it('passes a playlist lang through as before', async () => {
      const server = createMcpServer() as any;
      normalizeVideoInputMock.mockReturnValue(playlistUrl);
      sanitizeLangMock.mockReturnValue('de');
      downloadPlaylistSubtitlesMock.mockResolvedValue([]);

      await getTool(server, 'get_playlist_transcripts')(
        { url: 'PL1', type: 'official', lang: 'de' },
        {}
      );

      expect(downloadPlaylistSubtitlesMock).toHaveBeenCalledWith(
        playlistUrl,
        expect.objectContaining({ type: 'official', lang: 'de' }),
        expect.anything()
      );
    });
  });
});
