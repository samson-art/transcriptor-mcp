import { NotFoundError, ValidationError, YtDlpError } from './errors.js';
import {
  extractPlatformFromUrl,
  isValidYouTubeUrl,
  isValidSupportedUrl,
  normalizeVideoInput,
  parseTimecode,
  formatTimestamp,
  sanitizeVideoId,
  sanitizeLang,
  shouldAutoDiscoverSubtitles,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
  validateAndCaptureVideoFrame,
  resetVideoJsonInFlight,
} from './validation.js';
import * as youtube from './youtube.js';
import { get as cacheGet, set as cacheSet } from './cache.js';
import * as whisper from './whisper.js';
import * as whisperJobs from './whisper-jobs.js';

jest.mock('./whisper.js', () => ({
  getWhisperConfig: jest.fn(() => ({ mode: 'off', timeout: 600_000 })),
}));

jest.mock('./whisper-jobs.js', () => ({
  startOrReuseWhisperJob: jest.fn(),
}));

jest.mock('./cache.js', () => {
  const actual = jest.requireActual<typeof import('./cache.js')>('./cache.js');
  return {
    ...actual,
    getCacheConfig: jest.fn(() => ({
      mode: 'off',
      ttlSubtitlesSeconds: 604800,
      ttlMetadataSeconds: 3600,
    })),
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  };
});

// Every path that reads metadata now goes through fetchYtDlpJson: without a default spy a
// test that does not mock it would run the real yt-dlp against YouTube.
beforeEach(() => {
  jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetVideoJsonInFlight();
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

  describe('extractPlatformFromUrl', () => {
    it('should return youtube for YouTube URLs', () => {
      expect(extractPlatformFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
      expect(extractPlatformFromUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    });
    it('should return reddit for Reddit URLs', () => {
      expect(extractPlatformFromUrl('https://www.reddit.com/r/mcp/comments/1rstpfk/title/')).toBe(
        'reddit'
      );
      expect(extractPlatformFromUrl('https://v.redd.it/abc123')).toBe('reddit');
    });
    it('should return vimeo for Vimeo URLs', () => {
      expect(extractPlatformFromUrl('https://vimeo.com/123')).toBe('vimeo');
    });
    it('should return twitter for x.com (exact match, not fox.com/pixel.com)', () => {
      expect(extractPlatformFromUrl('https://x.com/user/status/123')).toBe('twitter');
      expect(extractPlatformFromUrl('https://m.x.com/user/status/123')).toBe('twitter');
      expect(extractPlatformFromUrl('https://fox.com/video')).toBe('unknown');
      expect(extractPlatformFromUrl('https://pixel.com/video')).toBe('unknown');
    });
    it('should return vk for VK domains (exact match, not avk.com)', () => {
      expect(extractPlatformFromUrl('https://vk.com/video123')).toBe('vk');
      expect(extractPlatformFromUrl('https://www.vk.com/video123')).toBe('vk');
      expect(extractPlatformFromUrl('https://vk.ru/video123')).toBe('vk');
      expect(extractPlatformFromUrl('https://vkvideo.ru/playlist/123')).toBe('vk');
      expect(extractPlatformFromUrl('https://avk.com/video')).toBe('unknown');
    });
    it('should return unknown for unsupported URLs', () => {
      expect(extractPlatformFromUrl('https://example.com/video')).toBe('unknown');
    });
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
        'https://vkvideo.ru/playlist/-220754053_5/video-220754053_456243238',
        'https://www.vkvideo.ru/playlist/-220754053_5/video-220754053_456243238',
        // Dailymotion
        'https://dailymotion.com/video/abc',
        'https://www.dailymotion.com/video/abc',
        // Reddit
        'https://www.reddit.com/r/subreddit/comments/abc123/title/',
        'https://old.reddit.com/r/videos/comments/xyz456/post_title/',
        'https://v.redd.it/video_id',
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
        [
          'https://vkvideo.ru/playlist/-220754053_5/video-220754053_456243238',
          'https://vkvideo.ru/playlist/-220754053_5/video-220754053_456243238',
        ],
        ['https://www.dailymotion.com/video/abc', 'https://www.dailymotion.com/video/abc'],
        [
          'https://www.reddit.com/r/subreddit/comments/abc123/title/',
          'https://www.reddit.com/r/subreddit/comments/abc123/title/',
        ],
        ['https://v.redd.it/video_id', 'https://v.redd.it/video_id'],
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

  describe('shouldAutoDiscoverSubtitles', () => {
    it('should return true when both type and lang are undefined', () => {
      expect(shouldAutoDiscoverSubtitles({ url: 'https://youtube.com/watch?v=x' })).toBe(true);
    });

    it('should return false when type is provided', () => {
      expect(
        shouldAutoDiscoverSubtitles({ url: 'https://youtube.com/watch?v=x', type: 'auto' })
      ).toBe(false);
    });

    it('should return false when lang is provided', () => {
      expect(
        shouldAutoDiscoverSubtitles({ url: 'https://youtube.com/watch?v=x', lang: 'en' })
      ).toBe(false);
    });
  });

  describe('validateAndDownloadSubtitles', () => {
    it('should surface a classified yt-dlp failure instead of "no subtitles"', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockRejectedValue(new YtDlpError('rate_limited'));
      const whisperSpy = jest.spyOn(whisperJobs, 'startOrReuseWhisperJob');

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        })
      ).rejects.toThrow(YtDlpError);
      // The platform is throttling us; transcribing audio would hit the same wall.
      expect(whisperSpy).not.toHaveBeenCalled();
    });

    it('should throw ValidationError for invalid YouTube URL', async () => {
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://unsupported.example.com/video',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toThrow(ValidationError);

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://unsupported.example.com/video',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid video URL' });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when sanitized video ID is invalid', async () => {
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://evil.com/not-allowed',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toThrow(ValidationError);
      await expect(
        validateAndDownloadSubtitles({
          url: 'https://evil.com/not-allowed',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid video URL' });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when language code is invalid', async () => {
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'invalid lang',
        } as any)
      ).rejects.toThrow(ValidationError);
      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'invalid lang',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid language code' });
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when subtitles are not found', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: {},
        automatic_captions: {},
      });

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toThrow(NotFoundError);
      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Subtitles not found' });
    });

    it('should return subtitles data on success', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('subtitle content');
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });

      const result = await validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'official',
        lang: ' en ',
      } as any);

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        type: 'official',
        lang: 'en',
        subtitlesContent: 'subtitle content',
        source: 'youtube',
      });
    });

    it('skips the cache when asked, so the canary always exercises yt-dlp', async () => {
      (cacheGet as jest.Mock).mockClear();
      (cacheSet as jest.Mock).mockClear();
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('fresh');
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });

      const result = await validateAndDownloadSubtitles(
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'auto', lang: 'en' } as any,
        undefined,
        { skipCache: true }
      );

      expect(result.subtitlesContent).toBe('fresh');
      expect(downloadSpy).toHaveBeenCalled();
      expect(cacheGet).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    });

    it('should return subtitles from Whisper fallback when YouTube has none', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local', timeout: 600_000 });
      (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript'
      );

      const result = await validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
      } as any);

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
        subtitlesContent: '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript',
        source: 'whisper',
      });
      expect(whisperJobs.startOrReuseWhisperJob).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'en',
        'srt',
        undefined
      );
    });

    it('should call cache.set when Whisper finishes after WHISPER_TIMEOUT (explicit lang)', async () => {
      (cacheSet as jest.Mock).mockClear();
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local', timeout: 1 });

      let lateResolve!: (v: string | null) => void;
      const jobPromise = new Promise<string | null>((resolve) => {
        lateResolve = resolve;
      });
      (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockReturnValue(jobPromise);

      const p = validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
      } as any);

      const rejectsAssert = expect(p).rejects.toThrow(NotFoundError);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      await rejectsAssert;

      lateResolve('1\n00:00:00,000 --> 00:00:01,000\nLate explicit');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(cacheSet).toHaveBeenCalled();
      const payloadCall = (cacheSet as jest.Mock).mock.calls.find(([, v]) =>
        String(v).includes('Late explicit')
      );
      expect(payloadCall).toBeDefined();
      expect(JSON.parse(String(payloadCall![1]))).toMatchObject({
        videoId: 'dQw4w9WgXcQ',
        source: 'whisper',
        lang: 'en',
      });
    });

    it('should throw NotFoundError when Whisper fallback is enabled but returns null', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: {},
        automatic_captions: {},
      });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local', timeout: 600_000 });
      (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(null);

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toThrow(NotFoundError);
      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Subtitles not found' });
    });

    it('should name the Whisper length limit when Whisper produced nothing', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: {},
        automatic_captions: {},
      });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local', timeout: 600_000 });
      (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(null);
      const request = {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
      } as any;

      await expect(validateAndDownloadSubtitles(request)).rejects.toThrow(
        /retry the same call once in a few minutes/
      );

      process.env.WHISPER_MAX_DURATION_SECONDS = '120';
      try {
        const err = await validateAndDownloadSubtitles(request).catch((e: Error) => e);
        expect((err as Error).message).toContain('only videos up to 120 seconds long');
        expect((err as Error).message).toContain('Do not repeat the same call');
        expect((err as Error).message).not.toContain('WHISPER_TIMEOUT');
      } finally {
        delete process.env.WHISPER_MAX_DURATION_SECONDS;
      }
    });

    it('should return subtitles data on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const vimeoUrl = 'https://vimeo.com/123';

      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('vimeo subtitle content');
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: '123' });

      const result = await validateAndDownloadSubtitles({
        url: vimeoUrl,
        type: 'auto',
        lang: 'en',
      } as any);

      expect(result).toEqual({
        videoId: '123',
        type: 'auto',
        lang: 'en',
        subtitlesContent: 'vimeo subtitle content',
        source: 'vimeo',
      });
      expect(youtube.downloadSubtitles).toHaveBeenCalledWith(
        vimeoUrl,
        'auto',
        'en',
        undefined,
        undefined,
        expect.objectContaining({ id: '123' })
      );
      // No id in the URL, so the id still costs one yt-dlp run.
      expect(youtube.fetchYtDlpJson).toHaveBeenCalled();
    });

    it('should read one JSON for the track URL, the id and the metadata caches', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('content');
      const jsonSpy = jest
        .spyOn(youtube, 'fetchYtDlpJson')
        .mockResolvedValue({ id: 'dQw4w9WgXcQ' });

      const result = await validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'auto',
        lang: 'en',
      } as any);

      expect(result.videoId).toBe('dQw4w9WgXcQ');
      expect(jsonSpy).toHaveBeenCalledTimes(1);
      // info, tracks and chapters are filled from that one run
      expect((cacheSet as jest.Mock).mock.calls.map((c) => String(c[0]).split(':')[0])).toEqual(
        expect.arrayContaining(['avail', 'info', 'chapters'])
      );
    });

    it('should answer a private video with its reason, not "no subtitles for en"', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockRejectedValue(new YtDlpError('private'));

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://vimeo.com/123',
          type: 'auto',
          lang: 'en',
        } as any)
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'private' });
    });

    describe('auto-discover (lang and type omitted)', () => {
      const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

      it('should use official subtitles when available', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: { en: [], ru: [] },
          automatic_captions: {},
        });
        const downloadSpy = jest
          .spyOn(youtube, 'downloadSubtitles')
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('official ru content');

        const result = await validateAndDownloadSubtitles({ url: youtubeUrl } as any);

        expect(result).toEqual({
          videoId: 'dQw4w9WgXcQ',
          type: 'official',
          lang: 'ru',
          subtitlesContent: 'official ru content',
          source: 'youtube',
        });
        expect(downloadSpy).toHaveBeenNthCalledWith(
          1,
          youtubeUrl,
          'official',
          'en',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
        expect(downloadSpy).toHaveBeenNthCalledWith(
          2,
          youtubeUrl,
          'official',
          'ru',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
      });

      it('should prefer -orig auto subtitles for YouTube when available', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: { en: [], 'en-orig': [], ru: [] },
        });
        const downloadSpy = jest
          .spyOn(youtube, 'downloadSubtitles')
          .mockResolvedValueOnce('en-orig content');

        const result = await validateAndDownloadSubtitles({ url: youtubeUrl } as any);

        expect(result).toEqual({
          videoId: 'dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en-orig',
          subtitlesContent: 'en-orig content',
          source: 'youtube',
        });
        expect(downloadSpy).toHaveBeenCalledWith(
          youtubeUrl,
          'auto',
          'en-orig',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
      });

      it('should iterate auto list when no -orig for YouTube', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: { en: [], ru: [] },
        });
        const downloadSpy = jest
          .spyOn(youtube, 'downloadSubtitles')
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('ru auto content');

        const result = await validateAndDownloadSubtitles({ url: youtubeUrl } as any);

        expect(result).toEqual({
          videoId: 'dQw4w9WgXcQ',
          type: 'auto',
          lang: 'ru',
          subtitlesContent: 'ru auto content',
          source: 'youtube',
        });
        expect(downloadSpy).toHaveBeenNthCalledWith(
          1,
          youtubeUrl,
          'auto',
          'en',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
        expect(downloadSpy).toHaveBeenNthCalledWith(
          2,
          youtubeUrl,
          'auto',
          'ru',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
      });

      it('should fallback to Whisper when no subtitles found', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: {},
        });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({
          mode: 'local',
          timeout: 600_000,
        });
        (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(
          '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript'
        );

        const result = await validateAndDownloadSubtitles({ url: youtubeUrl } as any);

        expect(result).toEqual({
          videoId: 'dQw4w9WgXcQ',
          type: 'auto',
          lang: '',
          subtitlesContent: '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript',
          source: 'whisper',
        });
        expect(whisperJobs.startOrReuseWhisperJob).toHaveBeenCalledWith(
          youtubeUrl,
          '',
          'srt',
          undefined
        );
      });

      it('should throw NotFoundError when all attempts and Whisper fail', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: {},
        });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({
          mode: 'local',
          timeout: 600_000,
        });
        (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(null);

        await expect(validateAndDownloadSubtitles({ url: youtubeUrl } as any)).rejects.toThrow(
          NotFoundError
        );
        await expect(
          validateAndDownloadSubtitles({ url: youtubeUrl } as any)
        ).rejects.toMatchObject({
          errorLabel: 'Subtitles not found',
          message: expect.stringContaining('No subtitles available'),
        });
      });

      it('should call cache.set when Whisper finishes after WHISPER_TIMEOUT (auto-discover)', async () => {
        (cacheSet as jest.Mock).mockClear();
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: {},
        });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({
          mode: 'local',
          timeout: 1,
        });

        let lateResolve!: (v: string | null) => void;
        const jobPromise = new Promise<string | null>((resolve) => {
          lateResolve = resolve;
        });
        (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockReturnValue(jobPromise);

        const p = validateAndDownloadSubtitles({ url: youtubeUrl } as any);
        const rejectsAssert = expect(p).rejects.toThrow(NotFoundError);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        await rejectsAssert;

        lateResolve('1\n00:00:00,000 --> 00:00:01,000\nLate transcript');
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(cacheSet).toHaveBeenCalled();
        const payloadCall = (cacheSet as jest.Mock).mock.calls.find(([, v]) =>
          String(v).includes('Late transcript')
        );
        expect(payloadCall).toBeDefined();
        expect(JSON.parse(String(payloadCall![1]))).toMatchObject({
          videoId: 'dQw4w9WgXcQ',
          source: 'whisper',
          lang: '',
        });
      });

      it('should maintain backward compatibility when type and lang are explicit', async () => {
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('explicit content');
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });

        const result = await validateAndDownloadSubtitles({
          url: youtubeUrl,
          type: 'auto',
          lang: 'en',
        } as any);

        expect(result).toEqual({
          videoId: 'dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
          subtitlesContent: 'explicit content',
          source: 'youtube',
        });
        expect(youtube.downloadSubtitles).toHaveBeenCalledTimes(1);
        expect(youtube.downloadSubtitles).toHaveBeenCalledWith(
          youtubeUrl,
          'auto',
          'en',
          undefined,
          undefined,
          expect.objectContaining({ id: 'dQw4w9WgXcQ' })
        );
      });
    });
  });

  describe('validateAndFetchAvailableSubtitles', () => {
    it('should throw ValidationError for invalid YouTube URL', async () => {
      const fetchSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null as any);

      await expect(
        validateAndFetchAvailableSubtitles({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toThrow(ValidationError);
      await expect(
        validateAndFetchAvailableSubtitles({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid video URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when sanitized video ID is invalid', async () => {
      const fetchSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null as any);

      await expect(
        validateAndFetchAvailableSubtitles({ url: 'https://evil.com/not-allowed' } as any)
      ).rejects.toThrow(ValidationError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when available subtitles are not found', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null);

      await expect(
        validateAndFetchAvailableSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toThrow(NotFoundError);
      await expect(
        validateAndFetchAvailableSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Video not found' });
    });

    it('should return available subtitles data on success', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: { en: [], ru: [] },
        automatic_captions: { en: [] },
      });

      const result = await validateAndFetchAvailableSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      } as any);

      expect(result).toEqual({
        videoId: 'dQw4w9WgXcQ',
        official: ['en', 'ru'],
        auto: ['en'],
      });
    });

    it('should return available subtitles data on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const vimeoUrl = 'https://vimeo.com/123';

      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: '123',
        subtitles: { en: [] },
        automatic_captions: {},
      });

      const result = await validateAndFetchAvailableSubtitles({ url: vimeoUrl } as any);

      expect(result).toEqual({
        videoId: '123',
        official: ['en'],
        auto: [],
      });
      expect(youtube.fetchYtDlpJson).toHaveBeenCalledWith(vimeoUrl, undefined);
    });
  });

  describe('validateAndFetchVideoInfo', () => {
    it('should throw ValidationError for invalid YouTube URL', async () => {
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(null as any);

      await expect(
        validateAndFetchVideoInfo({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toThrow(ValidationError);
      await expect(
        validateAndFetchVideoInfo({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid video URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when video info is not found', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(null);

      await expect(
        validateAndFetchVideoInfo({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toThrow(NotFoundError);
      await expect(
        validateAndFetchVideoInfo({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Video not found' });
    });

    it('should return video info on success', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        title: 'Test Video',
        channel: 'Test Channel',
        duration: 120,
      });

      const result = await validateAndFetchVideoInfo({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      } as any);

      expect(result.videoId).toBe('dQw4w9WgXcQ');
      expect(result.info).toMatchObject({
        id: 'dQw4w9WgXcQ',
        title: 'Test Video',
        channel: 'Test Channel',
        duration: 120,
      });
    });

    it('should return video info on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const vimeoUrl = 'https://vimeo.com/123';
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: '123',
        title: 'Vimeo Video',
        channel: 'Vimeo Channel',
        duration: 60,
      });

      const result = await validateAndFetchVideoInfo({ url: vimeoUrl } as any);

      expect(result.videoId).toBe('123');
      expect(result.info).toMatchObject({ title: 'Vimeo Video', duration: 60 });
      expect(youtube.fetchYtDlpJson).toHaveBeenCalledWith(vimeoUrl, undefined);
    });
  });

  describe('validateAndFetchVideoChapters', () => {
    it('should throw ValidationError for invalid YouTube URL', async () => {
      const fetchSpy = jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue([]);

      await expect(
        validateAndFetchVideoChapters({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toThrow(ValidationError);
      await expect(
        validateAndFetchVideoChapters({ url: 'https://unsupported.example.com/video' } as any)
      ).rejects.toMatchObject({ errorLabel: 'Invalid video URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when video is not found', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(null);

      await expect(
        validateAndFetchVideoChapters({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toThrow(NotFoundError);
      await expect(
        validateAndFetchVideoChapters({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        } as any)
      ).rejects.toMatchObject({ errorLabel: 'Video not found' });
    });

    it('should return chapters on success', async () => {
      const mockChapters = [
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ];
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(mockChapters);

      const result = await validateAndFetchVideoChapters({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      } as any);

      expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', chapters: mockChapters });
    });

    it('should return chapters on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const vimeoUrl = 'https://vimeo.com/123';
      const mockChapters: Array<{ startTime: number; endTime: number; title: string }> = [];
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: '123' });
      jest.spyOn(youtube, 'fetchVideoChapters').mockResolvedValue(mockChapters);

      const result = await validateAndFetchVideoChapters({ url: vimeoUrl } as any);

      expect(result).toEqual({ videoId: '123', chapters: mockChapters });
      expect(youtube.fetchVideoChapters).toHaveBeenCalledWith(vimeoUrl, undefined, {
        id: '123',
      });
    });

    it('should call fetchYtDlpJson once and pass data to fetchVideoChapters', async () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const mockChapters = [
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ];
      const mockData = { id: 'dQw4w9WgXcQ', chapters: mockChapters };
      const fetchJsonSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue(mockData as any);
      const fetchChaptersSpy = jest
        .spyOn(youtube, 'fetchVideoChapters')
        .mockResolvedValue(mockChapters);

      const result = await validateAndFetchVideoChapters({ url } as any);

      expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', chapters: mockChapters });
      expect(fetchJsonSpy).toHaveBeenCalledTimes(1);
      expect(fetchChaptersSpy).toHaveBeenCalledTimes(1);
      expect(fetchChaptersSpy).toHaveBeenCalledWith(url, undefined, mockData);
    });
  });

  describe('parseTimecode', () => {
    it('should parse MM:SS', () => {
      expect(parseTimecode('01:23')).toBe(83);
      expect(parseTimecode('0:05')).toBe(5);
    });

    it('should parse HH:MM:SS with optional millis', () => {
      expect(parseTimecode('00:01:23.500')).toBe(83.5);
      expect(parseTimecode('1:02:03')).toBe(3723);
      expect(parseTimecode('01:23.5')).toBe(83.5);
    });

    it('should return null for invalid input', () => {
      expect(parseTimecode('abc')).toBeNull();
      expect(parseTimecode('99')).toBeNull();
      expect(parseTimecode('1:60')).toBeNull();
      expect(parseTimecode('61:30')).toBeNull();
      expect(parseTimecode('-1:00')).toBeNull();
      expect(parseTimecode('')).toBeNull();
    });
  });

  describe('formatTimestamp', () => {
    it('should format seconds as HH:MM:SS.mmm', () => {
      expect(formatTimestamp(0)).toBe('00:00:00.000');
      expect(formatTimestamp(83.5)).toBe('00:01:23.500');
      expect(formatTimestamp(3723.042)).toBe('01:02:03.042');
    });
  });

  describe('validateAndCaptureVideoFrame', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    it('should reject invalid URL', async () => {
      await expect(
        validateAndCaptureVideoFrame({ url: 'https://example.com/video' })
      ).rejects.toThrow(ValidationError);
    });

    it('should reject when both timecode and seconds are provided', async () => {
      await expect(
        validateAndCaptureVideoFrame({ url, timecode: '01:23', seconds: 83 })
      ).rejects.toThrow('Provide either timecode or seconds');
    });

    it('should reject invalid timecode and negative seconds', async () => {
      await expect(validateAndCaptureVideoFrame({ url, timecode: 'abc' })).rejects.toThrow(
        'Invalid timecode'
      );
      await expect(validateAndCaptureVideoFrame({ url, seconds: -5 })).rejects.toThrow(
        ValidationError
      );
    });

    it('should capture with defaults (timestamp 0, jpeg, width 1280, quality 4)', async () => {
      const captureSpy = jest.spyOn(youtube, 'captureVideoFrame').mockResolvedValue({
        ok: true,
        videoId: 'dQw4w9WgXcQ',
        data: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });

      const result = await validateAndCaptureVideoFrame({ url });

      expect(captureSpy).toHaveBeenCalledWith(
        url,
        0,
        { format: 'jpeg', width: 1280, quality: 4 },
        undefined
      );
      expect(result).toMatchObject({
        videoId: 'dQw4w9WgXcQ',
        timestampSeconds: 0,
        timestamp: '00:00:00.000',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        width: null,
      });
      expect(result.data.equals(Buffer.from('img'))).toBe(true);
    });

    it('should resolve timecode and clamp width/quality', async () => {
      const captureSpy = jest.spyOn(youtube, 'captureVideoFrame').mockResolvedValue({
        ok: true,
        videoId: 'dQw4w9WgXcQ',
        data: Buffer.from('img'),
        mimeType: 'image/png',
      });

      await validateAndCaptureVideoFrame({
        url,
        timecode: '00:01:23.500',
        format: 'png',
        width: 5000,
        quality: 100,
      });

      expect(captureSpy).toHaveBeenCalledWith(
        url,
        83.5,
        { format: 'png', width: 1920, quality: 31 },
        undefined
      );
    });

    it('should map timestamp_beyond_duration to ValidationError', async () => {
      jest.spyOn(youtube, 'captureVideoFrame').mockResolvedValue({
        ok: false,
        reason: 'timestamp_beyond_duration',
        videoId: 'dQw4w9WgXcQ',
        durationSeconds: 100,
      });

      await expect(validateAndCaptureVideoFrame({ url, seconds: 200 })).rejects.toThrow(
        /beyond the video duration/
      );
    });

    it('should map capture_failed to NotFoundError without the ffmpeg details', async () => {
      jest.spyOn(youtube, 'captureVideoFrame').mockResolvedValue({
        ok: false,
        reason: 'capture_failed',
        videoId: 'dQw4w9WgXcQ',
        details: { message: 'Command failed: ffmpeg -i https://cdn.example/stream.mp4' },
      });

      await expect(validateAndCaptureVideoFrame({ url, seconds: 10 })).rejects.toMatchObject({
        name: 'NotFoundError',
        message: 'Failed to capture a frame for this video.',
      });
    });
  });
});
