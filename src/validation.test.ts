import { NotFoundError, ValidationError } from './errors.js';
import {
  extractPlatformFromUrl,
  isValidYouTubeUrl,
  isValidSupportedUrl,
  normalizeVideoInput,
  sanitizeVideoId,
  sanitizeLang,
  shouldAutoDiscoverSubtitles,
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

    it('should return subtitles from Whisper fallback when YouTube has none', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
      (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(
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
      expect(whisper.transcribeWithWhisper).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'en',
        'srt',
        undefined
      );
    });

    it('should throw NotFoundError when Whisper fallback is enabled but returns null', async () => {
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: {},
        automatic_captions: {},
      });
      (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
      (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(null);

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
        undefined
      );
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
          undefined
        );
        expect(downloadSpy).toHaveBeenNthCalledWith(
          2,
          youtubeUrl,
          'official',
          'ru',
          undefined,
          undefined
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
          undefined
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
          undefined
        );
        expect(downloadSpy).toHaveBeenNthCalledWith(
          2,
          youtubeUrl,
          'auto',
          'ru',
          undefined,
          undefined
        );
      });

      it('should fallback to Whisper when no subtitles found', async () => {
        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
          id: 'dQw4w9WgXcQ',
          subtitles: {},
          automatic_captions: {},
        });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
        (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(
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
        expect(whisper.transcribeWithWhisper).toHaveBeenCalledWith(
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
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local' });
        (whisper.transcribeWithWhisper as jest.Mock).mockResolvedValue(null);

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
          undefined
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
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(null);

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
      const mockInfo = {
        id: 'dQw4w9WgXcQ',
        title: 'Test Video',
        channel: 'Test Channel',
        duration: 120,
      } as any;
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(mockInfo);

      const result = await validateAndFetchVideoInfo({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      } as any);

      expect(result).toEqual({ videoId: 'dQw4w9WgXcQ', info: mockInfo });
    });

    it('should return video info on success for non-YouTube URL (e.g. Vimeo)', async () => {
      const vimeoUrl = 'https://vimeo.com/123';
      const mockInfo = {
        id: '123',
        title: 'Vimeo Video',
        channel: 'Vimeo Channel',
        duration: 60,
      } as any;
      jest.spyOn(youtube, 'fetchVideoInfo').mockResolvedValue(mockInfo);

      const result = await validateAndFetchVideoInfo({ url: vimeoUrl } as any);

      expect(result).toEqual({ videoId: '123', info: mockInfo });
      expect(youtube.fetchVideoInfo).toHaveBeenCalledWith(vimeoUrl, undefined);
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
});
