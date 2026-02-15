import { NotFoundError } from './errors.js';
import { createMcpServer } from './mcp-core.js';
import * as youtube from './youtube.js';
import * as validation from './validation.js';

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class FakeMcpServer {
    tools = new Map<string, (args: any, extra: any) => any>();

    registerTool(name: string, _definition: any, handler: (args: any, extra: any) => any) {
      this.tools.set(name, handler);
    }

    registerPrompt(_name: string, _config: any, _handler: any) {
      // no-op for tests that only exercise tools
    }

    registerResource(_name: string, _uri: string, _config: any, _handler: any) {
      // no-op for tests that only exercise tools
    }
  }

  return { McpServer: FakeMcpServer };
});

jest.mock('./youtube.js', () => ({
  detectSubtitleFormat: jest.fn(),
  parseSubtitles: jest.fn(),
  searchVideos: jest.fn(),
}));

jest.mock('./validation.js', () => ({
  normalizeVideoInput: jest.fn(),
  sanitizeLang: jest.fn(),
  validateAndDownloadSubtitles: jest.fn(),
  validateAndFetchAvailableSubtitles: jest.fn(),
  validateAndFetchVideoInfo: jest.fn(),
  validateAndFetchVideoChapters: jest.fn(),
}));

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

      const result = await handler({ url: testUrl }, {});

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        { url: testUrl, type: undefined, lang: undefined },
        expect.anything()
      );
      expect(parseSubtitlesMock).toHaveBeenCalledWith('subtitle content');

      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
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

    it('should return error when parsing subtitles fails', async () => {
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
      expect(result.content[0].text).toContain('parse error');
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

  describe('get_available_subtitles', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return error for invalid video id', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_available_subtitles');

      normalizeVideoInputMock.mockReturnValue(null);

      const result = await handler({ url: 'invalid' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Invalid video URL');
      expect(validateAndFetchAvailableSubtitlesMock).not.toHaveBeenCalled();
    });

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

    it('should return error when video id cannot be resolved', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(null);

      const result = await handler({ url: 'invalid' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Invalid video URL');
      expect(validateAndFetchVideoInfoMock).not.toHaveBeenCalled();
    });

    it('should return error when video info cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoInfoMock.mockRejectedValue(
        new NotFoundError('Not found', 'Video not found')
      );

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Failed to fetch video info');
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
      expect(result.content[0].text).toBe(errMsg);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), tool: 'get_video_info' }),
        'MCP tool unexpected error'
      );
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

  describe('get_video_chapters', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return error when video id cannot be resolved', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(null);

      const result = await handler({ url: 'invalid' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Invalid video URL');
      expect(validateAndFetchVideoChaptersMock).not.toHaveBeenCalled();
    });

    it('should return error when chapters cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      validateAndFetchVideoChaptersMock.mockRejectedValue(
        new NotFoundError('Not found', 'Video not found')
      );

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Failed to fetch chapters');
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
      expect(result.content[0].text).toContain('Failed to search videos');
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
});
