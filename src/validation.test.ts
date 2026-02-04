import {
  isValidYouTubeUrl,
  sanitizeVideoId,
  sanitizeLang,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
} from './validation.js';
import * as youtube from './youtube.js';

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
        { url: 'not-a-url', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid YouTube URL',
      });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should return 400 when sanitized video ID is invalid', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'extractVideoId').mockReturnValue('invalid id');
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      const result = await validateAndDownloadSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'auto', lang: 'en' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video ID',
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
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.payload).toBeUndefined();
    });
  });

  describe('validateAndFetchAvailableSubtitles', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest
        .spyOn(youtube, 'fetchAvailableSubtitles')
        .mockResolvedValue(null as any);

      const result = await validateAndFetchAvailableSubtitles({ url: 'not-a-url' } as any, reply);

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid YouTube URL',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 400 when sanitized video ID is invalid', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'extractVideoId').mockReturnValue('invalid id');
      const fetchSpy = jest
        .spyOn(youtube, 'fetchAvailableSubtitles')
        .mockResolvedValue(null as any);

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: 'Invalid video ID',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return 404 when available subtitles are not found', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'fetchAvailableSubtitles').mockResolvedValue(null);

      const result = await validateAndFetchAvailableSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as any,
        reply
      );

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(404);
      expect(reply.payload).toMatchObject({
        error: 'Subtitles not found',
      });
    });

    it('should return available subtitles data on success', async () => {
      const reply = createReplyMock();

      jest.spyOn(youtube, 'fetchAvailableSubtitles').mockResolvedValue({
        official: ['en', 'ru'],
        auto: ['en'],
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
  });

  describe('validateAndFetchVideoInfo', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(null as any);

      const result = await validateAndFetchVideoInfo({ url: 'not-a-url' } as any, reply);

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({ error: 'Invalid YouTube URL' });
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
  });

  describe('validateAndFetchVideoChapters', () => {
    it('should return 400 for invalid YouTube URL', async () => {
      const reply = createReplyMock();
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue([]);

      const result = await validateAndFetchVideoChapters({ url: 'not-a-url' } as any, reply);

      expect(result).toBeNull();
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({ error: 'Invalid YouTube URL' });
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
  });
});
