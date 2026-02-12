import {
  isValidYouTubeUrl,
  isValidSupportedUrl,
  normalizeVideoInput,
  sanitizeVideoId,
  sanitizeLang,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
} from './validation.js';
import * as youtube from './youtube.js';
import * as whisper from './whisper.js';

jest.mock('./whisper.js', () => ({
  getWhisperConfig: jest.fn(() => ({ mode: 'off' })),
  transcribeWithWhisper: jest.fn(),
}));

function createReplyMock() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    statusCode: 200,
    payload: undefined as unknown,
    code(this: any, statusCode: number) {
      this.statusCode = statusCode;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return this;
    },
    send(this: any, payload: unknown) {
      this.payload = payload;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return this;
    },
  } as any;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('validation', () => {
  describe('isValidYouTubeUrl', () => {
    it('should return true for valid YouTube URLs', () => {
      const validUrls = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
        'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      ];

      validUrls.forEach((url) => {
        expect(isValidYouTubeUrl(url)).toBe(true);
      });
    });

    it('should return false for invalid URLs', () => {
      const invalidUrls = [
        '',
        'not-a-url',
        'https://example.com/watch?v=dQw4w9WgXcQ',
        'https://vimeo.com/123456',
        'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtube.com',
        'https://youtube.com/watch',
      ];

      invalidUrls.forEach((url) => {
        expect(isValidYouTubeUrl(url)).toBe(false);
      });
    });

    it('should return false for non-string inputs', () => {
      expect(isValidYouTubeUrl(null as any)).toBe(false);
      expect(isValidYouTubeUrl(undefined as any)).toBe(false);
      expect(isValidYouTubeUrl(123 as any)).toBe(false);
    });
  });

  it('should return true for valid YouTube subdomains', () => {
    expect(isValidYouTubeUrl('https://sub.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  describe('isValidSupportedUrl', () => {
    it('should return true for YouTube URL and ID-like string', () => {
      expect(isValidSupportedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(isValidSupportedUrl('dQw4w9WgXcQ')).toBe(true);
    });

    it('should return true for all supported platform domains', () => {
      const supportedPlatformUrls = [
        // YouTube
        'https://youtube.com/watch?v=id',
        'https://www.youtube.com/watch?v=id',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=id',
        // Twitter/X
        'https://x.com/user/status/123',
        'https://twitter.com/user/status/123',
        'https://www.twitter.com/user/status/123',
        // Instagram
        'https://instagram.com/p/abc',
        'https://www.instagram.com/p/abc',
        // TikTok
        'https://tiktok.com/@u/video/1',
        'https://www.tiktok.com/@user/video/1',
        'https://vm.tiktok.com/xxx',
        // Twitch
        'https://twitch.tv/videos/1',
        'https://www.twitch.tv/videos/1',
        // Vimeo
        'https://vimeo.com/123',
        'https://www.vimeo.com/123',
        // Facebook
        'https://facebook.com/watch?v=1',
        'https://www.facebook.com/watch?v=1',
        'https://fb.watch/abc',
        'https://fb.com/watch?v=1',
        'https://m.facebook.com/watch?v=1',
        // Bilibili
        'https://bilibili.com/video/av1',
        'https://www.bilibili.com/video/av1',
        // VK
        'https://vk.com/video123',
        'https://vk.ru/video123',
        'https://www.vk.com/video123',
        // Dailymotion
        'https://dailymotion.com/video/abc',
        'https://www.dailymotion.com/video/abc',
      ];
      supportedPlatformUrls.forEach((url) => {
        expect(isValidSupportedUrl(url)).toBe(true);
      });
    });

    it('should return true for subdomain of allowed domain', () => {
      expect(isValidSupportedUrl('https://sub.youtube.com/watch?v=id')).toBe(true);
      expect(isValidSupportedUrl('https://api.vimeo.com/videos/123')).toBe(true);
    });

    it('should return false for unsupported domains and invalid input', () => {
      expect(isValidSupportedUrl('https://unsupported.example.com/video')).toBe(false);
      expect(isValidSupportedUrl('')).toBe(false);
      expect(isValidSupportedUrl('invalid id')).toBe(false);
    });
  });

  describe('normalizeVideoInput', () => {
    it('should return YouTube URL for bare ID', () => {
      expect(normalizeVideoInput('dQw4w9WgXcQ')).toBe(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      );
    });

    it('should return normalized URL for each supported platform', () => {
      const platformUrls: Array<[string, string]> = [
        ['https://www.youtube.com/watch?v=id', 'https://www.youtube.com/watch?v=id'],
        ['https://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ'],
        ['https://x.com/user/status/123', 'https://x.com/user/status/123'],
        ['https://twitter.com/user/status/123', 'https://twitter.com/user/status/123'],
        ['https://instagram.com/p/abc', 'https://instagram.com/p/abc'],
        ['https://www.tiktok.com/@user/video/1', 'https://www.tiktok.com/@user/video/1'],
        ['https://twitch.tv/videos/1', 'https://twitch.tv/videos/1'],
        ['https://vimeo.com/123', 'https://vimeo.com/123'],
        ['https://www.facebook.com/watch?v=1', 'https://www.facebook.com/watch?v=1'],
        ['https://fb.watch/abc', 'https://fb.watch/abc'],
        ['https://bilibili.com/video/av1', 'https://bilibili.com/video/av1'],
        ['https://vk.com/video123', 'https://vk.com/video123'],
        ['https://www.dailymotion.com/video/abc', 'https://www.dailymotion.com/video/abc'],
      ];
      platformUrls.forEach(([input, expected]) => {
        expect(normalizeVideoInput(input)).toBe(expected);
      });
    });

    it('should return null for unsupported URL or invalid ID', () => {
      expect(normalizeVideoInput('https://evil.com/v')).toBeNull();
      expect(normalizeVideoInput('')).toBeNull();
      expect(normalizeVideoInput('bad id')).toBeNull();
    });
  });

  describe('sanitizeVideoId', () => {
    it('should return sanitized video ID for valid inputs', () => {
      expect(sanitizeVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(sanitizeVideoId('abc123XYZ')).toBe('abc123XYZ');
      expect(sanitizeVideoId('test-video_id')).toBe('test-video_id');
      expect(sanitizeVideoId('  dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
    });

    it('should return null for invalid video IDs', () => {
      expect(sanitizeVideoId('')).toBe(null);
      expect(sanitizeVideoId('invalid@id')).toBe(null);
      expect(sanitizeVideoId('invalid id')).toBe(null);
      expect(sanitizeVideoId('invalid.id')).toBe(null);
      expect(sanitizeVideoId('a'.repeat(51))).toBe(null); // Too long
    });

    it('should return null for non-string inputs', () => {
      expect(sanitizeVideoId(null as any)).toBe(null);
      expect(sanitizeVideoId(undefined as any)).toBe(null);
      expect(sanitizeVideoId(123 as any)).toBe(null);
    });

    it('should allow video IDs with max allowed length', () => {
      const id = 'a'.repeat(50);
      expect(sanitizeVideoId(id)).toBe(id);
    });
  });

  describe('sanitizeLang', () => {
    it('should return sanitized language code for valid inputs', () => {
      expect(sanitizeLang('en')).toBe('en');
      expect(sanitizeLang('ru')).toBe('ru');
      expect(sanitizeLang('en-US')).toBe('en-US');
      expect(sanitizeLang('zh-CN')).toBe('zh-CN');
      expect(sanitizeLang('  en  ')).toBe('en');
    });

    it('should return null for invalid language codes', () => {
      expect(sanitizeLang('')).toBe(null);
      expect(sanitizeLang('invalid@lang')).toBe(null);
      expect(sanitizeLang('invalid lang')).toBe(null);
      expect(sanitizeLang('invalid.lang')).toBe(null);
      expect(sanitizeLang('a'.repeat(11))).toBe(null); // Too long
    });

    it('should return null for non-string inputs', () => {
      expect(sanitizeLang(null as any)).toBe(null);
      expect(sanitizeLang(undefined as any)).toBe(null);
      expect(sanitizeLang(123 as any)).toBe(null);
    });

    it('should allow language codes with max allowed length', () => {
      const lang = 'a'.repeat(10);
      expect(sanitizeLang(lang)).toBe(lang);
    });
  });

  describe('validateAndDownloadSubtitles', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        { url: 'https://unsupported.example.com/video', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video URL',
      });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should return 400 when sanitized video ID is invalid', async () => {
      const reply = createReplyMock();
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        { url: 'https://evil.com/not-allowed', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video URL',
      });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should return 400 when language code is invalid', async () => {
      const reply = createReplyMock();
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'invalid lang',
        } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid language code',
      });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should return 404 when subtitles are not found', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({
        error: 'Subtitles not found',
      });
    });

    it('should return subtitles data on success', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('subtitle content');
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });

      const result = await validateAndDownloadSubtitles(
        {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'official',
          lang: ' en ',
        } as any,
        reply
      );

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        type: 'official',
        lang: 'en',
        subtitlesContent: 'subtitle content',
        source: 'youtube',
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.payload).toBeUndefined();
    });

    it('should return subtitles from Whisper fallback when YouTube has none', async () => {
      const reply = createReplyMock();
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
      (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript'
      );

      const result = await validateAndDownloadSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
        subtitlesContent: '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript',
        source: 'whisper',
      });
      expect(reply.statusCode).toBe(200);
      expect(whisper.transcribeWithWhisper).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'en',
        'srt',
        undefined
      );
    });

    it('should return 404 when Whisper fallback is enabled but returns null', async () => {
      const reply = createReplyMock();
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
      (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({ error: 'Subtitles not found' });
    });

    it('should return subtitles data on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const reply = createReplyMock();
      const vimeoUrl = 'https://vimeo.com/123';

      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('vimeo subtitle content');
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: '123' });

      const result = await validateAndDownloadSubtitles(
        { url: vimeoUrl, type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toEqual({
        videoId: '123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: 'vimeo subtitle content',
        source: 'youtube',
      });
      expect(reply.statusCode).toBe(200);
      expect(youtube.downloadSubtitles).toHaveBeenCalledWith(vimeoUrl, 'auto', 'en', undefined);
    });
  });

  describe('validateAndFetchAvailableSubtitles', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null as any);

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://unsupported.example.com/video' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video URL',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 400 when sanitized video ID is invalid', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null as any);

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://evil.com/not-allowed' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video URL',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 404 when available subtitles are not found', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null);

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({
        error: 'Video not found',
      });
    });

    it('should return available subtitles data on success', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: { en: [], ru: [] },
        automatic_captions: { en: [] },
      });

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        official: ['en', 'ru'],
        auto: ['en'],
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.payload).toBeUndefined();
    });

    it('should return available subtitles data on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const reply = createReplyMock();
      const vimeoUrl = 'https://vimeo.com/123';

      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: '123',
        subtitles: { en: [] },
        automatic_captions: {},
      });

      const result = await validateAndFetchAvailableSubtitles({ url: vimeoUrl } as any, reply);

      expect(result).toEqual({
        videoId: '123',
        official: ['en'],
        auto: [],
      });
      expect(reply.statusCode).toBe(200);
      expect(youtube.fetchYtDlpJson).toHaveBeenCalledWith(vimeoUrl, undefined);
    });
  });

  describe('validateAndFetchVideoInfo', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(null as any);

      const result = await validateAndFetchVideoInfo(
        { url: 'https://unsupported.example.com/video' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({ error: 'Invalid video URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 404 when video info is not found', async () => {
      const reply = createReplyMock();
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(null);

      const result = await validateAndFetchVideoInfo(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({ error: 'Video not found' });
    });

    it('should return video info on success', async () => {
      const reply = createReplyMock();
      const mockInfo = {
        id: 'dQw4w9WgXcQ',
        title: 'Test Video',
        channel: 'Test Channel',
        duration: 120,
      } as any;
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(mockInfo);

      const result = await validateAndFetchVideoInfo(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', info: mockInfo });
      expect(reply.statusCode).toBe(200);
    });

    it('should return video info on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const reply = createReplyMock();
      const vimeoUrl = 'https://vimeo.com/123';
      const mockInfo = {
        id: '123',
        title: 'Vimeo Video',
        channel: 'Vimeo Channel',
        duration: 60,
      } as any;
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(mockInfo);

      const result = await validateAndFetchVideoInfo({ url: vimeoUrl } as any, reply);

      expect(result).toEqual({ videoId: '123', info: mockInfo });
      expect(reply.statusCode).toBe(200);
      expect(youtube.fetchVideoInfo).toHaveBeenCalledWith(vimeoUrl, undefined);
    });
  });

  describe('validateAndFetchVideoChapters', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue([]);

      const result = await validateAndFetchVideoChapters(
        { url: 'https://unsupported.example.com/video' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({ error: 'Invalid video URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 404 when video is not found', async () => {
      const reply = createReplyMock();
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(null);

      const result = await validateAndFetchVideoChapters(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({ error: 'Video not found' });
    });

    it('should return chapters on success', async () => {
      const reply = createReplyMock();
      const mockChapters = [
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ];
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(mockChapters);

      const result = await validateAndFetchVideoChapters(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', chapters: mockChapters });
      expect(reply.statusCode).toBe(200);
    });

    it('should return chapters on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const reply = createReplyMock();
      const vimeoUrl = 'https://vimeo.com/123';
      const mockChapters: Array<{ startTime: number; endTime: number; title: string }> = [];
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: '123' });
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(mockChapters);

      const result = await validateAndFetchVideoChapters({ url: vimeoUrl } as any, reply);

      expect(result).toEqual({ videoId: '123', chapters: mockChapters });
      expect(reply.statusCode).toBe(200);
      expect(youtube.fetchVideoChapters).toHaveBeenCalledWith(vimeoUrl, undefined);
    });
  });
});
