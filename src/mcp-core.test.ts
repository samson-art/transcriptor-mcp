import { createMcpServer } from './mcp-core.js';
import * as youtube from './youtube.js';
import * as validation from './validation.js';
import * as whisper from './whisper.js';

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class FakeMcpServer {
    tools = new Map<string, (args: any, extra: any) => any>();

    registerTool(name: string, _definition: any, handler: (args: any, extra: any) => any) {
      this.tools.set(name, handler);
    }
  }

  return { McpServer: FakeMcpServer };
});

jest.mock('./youtube.js', () => ({
  detectSubtitleFormat: jest.fn(),
  downloadSubtitles: jest.fn(),
  extractVideoId: jest.fn(),
  fetchAvailableSubtitles: jest.fn(),
  fetchVideoChapters: jest.fn(),
  fetchVideoInfo: jest.fn(),
  fetchYtDlpJson: jest.fn(),
  parseSubtitles: jest.fn(),
}));

jest.mock('./validation.js', () => ({
  normalizeVideoInput: jest.fn(),
  sanitizeLang: jest.fn(),
}));

jest.mock('./whisper.js', () => ({
  getWhisperConfig: jest.fn(),
  transcribeWithWhisper: jest.fn(),
}));

const downloadSubtitlesMock = youtube.downloadSubtitles as jest.Mock;
const detectSubtitleFormatMock = youtube.detectSubtitleFormat as jest.Mock;
const fetchAvailableSubtitlesMock = youtube.fetchAvailableSubtitles as jest.Mock;
const fetchVideoInfoMock = youtube.fetchVideoInfo as jest.Mock;
const fetchVideoChaptersMock = youtube.fetchVideoChapters as jest.Mock;
const fetchYtDlpJsonMock = youtube.fetchYtDlpJson as jest.Mock;
const parseSubtitlesMock = youtube.parseSubtitles as jest.Mock;
const extractVideoIdMock = youtube.extractVideoId as jest.Mock;

const normalizeVideoInputMock = validation.normalizeVideoInput as jest.Mock;
const sanitizeLangMock = validation.sanitizeLang as jest.Mock;
const getWhisperConfigMock = whisper.getWhisperConfig as jest.Mock;
const transcribeWithWhisperMock = whisper.transcribeWithWhisper as jest.Mock;

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
    getWhisperConfigMock.mockReturnValue({ mode: 'off' });
  });

  describe('get_transcript', () => {
    const testUrl = 'https://www.youtube.com/watch?v=video123';

    it('should return paginated transcript on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      downloadSubtitlesMock.mockResolvedValue('subtitle content');
      parseSubtitlesMock.mockReturnValue('abcdefghij'); // 10 chars
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');

      const result = await handler(
        {
          url: testUrl,
          type: 'auto',
          lang: 'en',
          response_limit: 4,
        },
        {}
      );

      expect(downloadSubtitlesMock).toHaveBeenCalledWith(testUrl, 'auto', 'en', expect.anything());
      expect(parseSubtitlesMock).toHaveBeenCalledWith('subtitle content');

      expect(result.structuredContent).toMatchObject({
        videoId: 'video123',
        type: 'auto',
        lang: 'en',
        text: 'abcd',
        is_truncated: true,
        total_length: 10,
        start_offset: 0,
        end_offset: 4,
        next_cursor: '4',
      });
      expect(result.content[0]).toEqual({ type: 'text', text: 'abcd' });
    });

    it('should return error when subtitles are not found', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      downloadSubtitlesMock.mockResolvedValue(null);

      const result = await handler({ url: testUrl, type: 'auto', lang: 'en' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Subtitles not found');
    });

    it('should return error when parsing subtitles fails', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      downloadSubtitlesMock.mockResolvedValue('subtitle content');
      parseSubtitlesMock.mockImplementation(() => {
        throw new Error('parse error');
      });

      const result = await handler({ url: testUrl, type: 'auto', lang: 'en' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('parse error');
    });

    it('should throw on invalid next_cursor', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      sanitizeLangMock.mockReturnValue('en');
      downloadSubtitlesMock.mockResolvedValue('subtitle content');
      parseSubtitlesMock.mockReturnValue('short');

      await expect(
        handler(
          {
            url: testUrl,
            type: 'auto',
            lang: 'en',
            response_limit: 10,
            next_cursor: '999',
          },
          {}
        )
      ).rejects.toThrow('Invalid next_cursor value.');
    });

    it('should call Whisper fallback with empty lang (auto-detect) when lang is omitted', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_transcript');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      downloadSubtitlesMock.mockResolvedValue(null);
      getWhisperConfigMock.mockReturnValue({ mode: 'local' });
      transcribeWithWhisperMock.mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:01,000\nAuto-detected transcript'
      );
      parseSubtitlesMock.mockReturnValue('Auto-detected transcript');
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');

      const result = await handler({ url: testUrl, type: 'auto' }, {});

      expect(downloadSubtitlesMock).toHaveBeenCalledWith(testUrl, 'auto', 'en', expect.anything());
      expect(transcribeWithWhisperMock).toHaveBeenCalledWith(testUrl, '', 'srt', expect.anything());
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
      downloadSubtitlesMock.mockResolvedValue('abcdefghij');
      detectSubtitleFormatMock.mockReturnValue('srt');
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');

      const result = await handler(
        { url: testUrl, type: 'official', lang: 'en', response_limit: 6 },
        {}
      );

      expect(downloadSubtitlesMock).toHaveBeenCalledWith(
        testUrl,
        'official',
        'en',
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
      expect(fetchAvailableSubtitlesMock).not.toHaveBeenCalled();
    });

    it('should return structured list of subtitles', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_available_subtitles');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      fetchAvailableSubtitlesMock.mockResolvedValue({
        official: ['en', 'ru'],
        auto: ['en'],
      });
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');

      const result = await handler({ url: 'video123' }, {});

      expect(fetchAvailableSubtitlesMock).toHaveBeenCalledWith(testUrl);
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
      expect(fetchVideoInfoMock).not.toHaveBeenCalled();
    });

    it('should return error when video info cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_info');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      fetchVideoInfoMock.mockResolvedValue(null);

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Failed to fetch video info');
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

      fetchVideoInfoMock.mockResolvedValue(info);

      const result = await handler({ url: testUrl }, {});

      expect(fetchVideoInfoMock).toHaveBeenCalledWith(testUrl);
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
      expect(fetchVideoChaptersMock).not.toHaveBeenCalled();
    });

    it('should return error when chapters cannot be fetched', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      fetchVideoChaptersMock.mockResolvedValue(null);

      const result = await handler({ url: 'video123' }, {});

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toContain('Failed to fetch chapters');
    });

    it('should return structured chapters on success', async () => {
      const server = createMcpServer() as any;
      const handler = getTool(server, 'get_video_chapters');

      normalizeVideoInputMock.mockReturnValue(testUrl);
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');

      const chapters = [
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ];
      fetchVideoChaptersMock.mockResolvedValue(chapters);

      const result = await handler({ url: testUrl }, {});

      expect(fetchVideoChaptersMock).toHaveBeenCalledWith(testUrl);
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
      fetchYtDlpJsonMock.mockResolvedValue({ id: 'video123' });
      extractVideoIdMock.mockReturnValue('video123');
      fetchVideoChaptersMock.mockResolvedValue([]);

      const result = await handler({ url: 'video123' }, {});

      expect(result.structuredContent).toEqual({
        videoId: 'video123',
        chapters: [],
      });
      expect(result.content[0].text).toContain('No chapters found');
    });
  });
});
