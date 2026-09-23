import { INVALID_VIDEO_URL_MESSAGE, NotFoundError, ValidationError, YtDlpError } from './errors.js';
import {
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
  validateVideoRequest,
  resetVideoJsonInFlight,
} from './validation.js';
import { extractPlatformFromUrl } from './platform.js';
import * as youtube from './youtube.js';
import { renderPrometheus } from './metrics.js';
import { get as cacheGet, set as cacheSet } from './cache.js';
import * as whisper from './whisper.js';
import * as whisperJobs from './whisper-jobs.js';
import {
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';

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

    it('accepts the track names yt-dlp lists besides plain language codes', () => {
      expect(sanitizeLang('en_US')).toBe('en_US'); // Facebook locale
      expect(sanitizeLang('en-nP7-2PuUl7o')).toBe('en-nP7-2PuUl7o'); // YouTube named track
      expect(sanitizeLang('en-x-autogen')).toBe('en-x-autogen'); // Vimeo auto captions
    });

    it('should return null for invalid language codes', () => {
      expect(sanitizeLang('')).toBe(null);
      expect(sanitizeLang('invalid@lang')).toBe(null);
      expect(sanitizeLang('invalid lang')).toBe(null);
      expect(sanitizeLang('invalid.lang')).toBe(null);
      expect(sanitizeLang('a'.repeat(33))).toBe(null); // Too long
    });

    it('rejects what yt-dlp would read as more than one literal track', () => {
      // --sub-langs is a comma list of regexes, `-x` excludes x, `all` is every track.
      for (const lang of ['en,ru', 'en.*', 'en|ru', 'a b', '-en', 'all', '__proto__']) {
        expect(sanitizeLang(lang)).toBe(null);
      }
    });

    it('should return null for non-string inputs', () => {
      expect(sanitizeLang(null as any)).toBe(null);
      expect(sanitizeLang(undefined as any)).toBe(null);
      expect(sanitizeLang(123 as any)).toBe(null);
    });

    it('should allow language codes with max allowed length', () => {
      const lang = 'a'.repeat(32);
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
    async function untriedTracks(): Promise<number> {
      const line = (await renderPrometheus())
        .split('\n')
        .find((l) => l.startsWith('subtitle_tracks_untried_total{platform="youtube"'));
      return line ? Number(line.split(' ').pop()) : 0;
    }

    it('asks for the track anyone wanted, not the alphabetically first one', async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: { ar: [{ ext: 'vtt' }], de: [{ ext: 'vtt' }], en: [{ ext: 'vtt' }] },
      } as never);
      const download = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('WEBVTT\n\nhi');

      const result = await validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });

      expect(result.lang).toBe('en');
      expect(download).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.any(String),
        'official',
        'en',
        undefined,
        undefined,
        expect.anything()
      );
    });

    it("prefers the video's own language over English", async () => {
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        language: 'de',
        subtitles: { ar: [{ ext: 'vtt' }], de: [{ ext: 'vtt' }], en: [{ ext: 'vtt' }] },
      } as never);
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('WEBVTT\n\nhi');

      const result = await validateAndDownloadSubtitles({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });

      expect(result.lang).toBe('de');
    });

    it('asks twice at most, and counts the tracks it left untried', async () => {
      const many = (langs: string[]) => Object.fromEntries(langs.map((l) => [l, [{ ext: 'vtt' }]]));
      jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
        id: 'dQw4w9WgXcQ',
        subtitles: many(['ar', 'de', 'es', 'fr', 'it']),
        automatic_captions: many(['ar', 'de', 'es', 'fr', 'it']),
      } as never);
      // Every track listed, none of them downloadable: the ladder must stop, not walk.
      const download = jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
      const before = await untriedTracks();

      await expect(
        validateAndDownloadSubtitles({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
      ).rejects.toThrow(NotFoundError);

      expect(download).toHaveBeenCalledTimes(2);
      // Ten listed, two asked for: the other eight are what the cap cost, and they are
      // the number to watch if callers start hearing "no subtitles" for videos that have some.
      expect(await untriedTracks()).toBe(before + 8);
    });

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

    afterEach(resetSubtitleRateLimitsForTests);

    it('refuses a held platform before it runs yt-dlp for metadata', async () => {
      // The point of the hold is that nothing leaves the server, and that the caller is
      // not kept waiting for a metadata run whose answer cannot be used anyway.
      noteSubtitlesRateLimited('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      const jsonSpy = jest.spyOn(youtube, 'fetchYtDlpJson');
      const downloadSpy = jest.spyOn(youtube, 'downloadSubtitles');

      await expect(
        validateAndDownloadSubtitles({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          type: 'auto',
          lang: 'en',
        })
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });

      // Auto-discovery reads the track list first, so it must be refused there too.
      await expect(
        validateAndDownloadSubtitles({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });

      expect(jsonSpy).not.toHaveBeenCalled();
      expect(downloadSpy).not.toHaveBeenCalled();
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
      // One probe, one yt-dlp run: the metadata JSON is for callers, not for the canary.
      expect(youtube.fetchYtDlpJson).not.toHaveBeenCalled();
      expect(downloadSpy.mock.calls[0][5]).toBeUndefined();
    });

    it('keys the cache by the format the content is in, not by whether one was named', async () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const keysFor = async (request: Record<string, unknown>) => {
        (cacheGet as jest.Mock).mockClear();
        await validateAndDownloadSubtitles({ url, ...request } as any).catch(() => null);
        return (cacheGet as jest.Mock).mock.calls.map((call) => call[0] as string);
      };
      jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('subtitle content');

      const autoKey = `sub:${url}:auto-discovery:srt`;
      expect(await keysFor({})).toContain(autoKey);
      expect(await keysFor({ format: 'srt' })).toContain(autoKey);
      const explicitKey = `sub:${url}:official:en:srt`;
      expect(await keysFor({ type: 'official', lang: 'en' })).toContain(explicitKey);
      expect(await keysFor({ type: 'official', lang: 'en', format: 'srt' })).toContain(explicitKey);

      process.env.YT_DLP_SUB_FORMAT = 'vtt';
      try {
        // The default moved: an unnamed format is now vtt, and srt is its own entry.
        expect(await keysFor({})).toContain(`sub:${url}:auto-discovery:vtt`);
        expect(await keysFor({ format: 'srt' })).toContain(autoKey);
      } finally {
        delete process.env.YT_DLP_SUB_FORMAT;
      }
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

      it('also stores the track it found under the key the explicit flow reads', async () => {
        // The transcript widget then asks for that track by name; a Whisper result has
        // no track to name and stays under the auto-discovery key alone.
        const storedSubKeys = async (url: string) => {
          (cacheSet as jest.Mock).mockClear();
          await validateAndDownloadSubtitles({ url } as any);
          return (cacheSet as jest.Mock).mock.calls
            .map((call) => call[0] as string)
            .filter((key) => key.startsWith('sub:'));
        };

        jest
          .spyOn(youtube, 'fetchYtDlpJson')
          .mockResolvedValue({ id: 'dQw4w9WgXcQ', subtitles: { en: [] } });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('official en content');
        expect(await storedSubKeys(youtubeUrl)).toEqual(
          expect.arrayContaining([
            `sub:${youtubeUrl}:auto-discovery:srt`,
            `sub:${youtubeUrl}:official:en:srt`,
          ])
        );

        jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({ id: 'dQw4w9WgXcQ' });
        (whisper.getWhisperConfig as jest.Mock).mockReturnValue({
          mode: 'local',
          timeout: 600_000,
        });
        (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(
          '1\n00:00:00,000 --> 00:00:01,000\nWhisper transcript'
        );
        expect(await storedSubKeys(youtubeUrl)).toEqual([`sub:${youtubeUrl}:auto-discovery:srt`]);

        // Facebook keys tracks by locale: the widget asks for `en_US` by name, so that
        // name gets its entry as well.
        const facebookUrl = 'https://www.facebook.com/watch?v=1';
        jest
          .spyOn(youtube, 'fetchYtDlpJson')
          .mockResolvedValue({ id: '1', subtitles: { en_US: [] } });
        jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue('official en_US content');
        expect(await storedSubKeys(facebookUrl)).toEqual([
          `sub:${facebookUrl}:auto-discovery:srt`,
          `sub:${facebookUrl}:official:en_US:srt`,
        ]);
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
          message: expect.stringContaining('No subtitles could be downloaded'),
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

  describe('one yt-dlp run per video', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    it('should answer three tools about one video with one run', async () => {
      let release: (value: any) => void = () => {};
      const deferred = new Promise<any>((resolve) => {
        release = resolve;
      });
      const jsonSpy = jest.spyOn(youtube, 'fetchYtDlpJson').mockReturnValue(deferred);

      const all = Promise.all([
        validateAndFetchVideoInfo({ url } as any),
        validateAndFetchVideoChapters({ url } as any),
        validateAndFetchAvailableSubtitles({ url } as any),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      release({ id: 'dQw4w9WgXcQ', title: 'Test', chapters: null, subtitles: { en: [] } });

      const [info, chapters, avail] = await all;
      expect(jsonSpy).toHaveBeenCalledTimes(1);
      expect(info.videoId).toBe('dQw4w9WgXcQ');
      expect(chapters.chapters).toEqual([]);
      expect(avail.official).toEqual(['en']);
    });

    it('should not keep a failed run for the next caller', async () => {
      const jsonSpy = jest
        .spyOn(youtube, 'fetchYtDlpJson')
        .mockRejectedValueOnce(new YtDlpError('bot_check'));

      await expect(validateAndFetchVideoInfo({ url } as any)).rejects.toMatchObject({
        reason: 'bot_check',
      });

      jsonSpy.mockResolvedValue({ id: 'dQw4w9WgXcQ', title: 'Test' });
      const info = await validateAndFetchVideoInfo({ url } as any);
      expect(info.info).toMatchObject({ title: 'Test' });
      expect(jsonSpy).toHaveBeenCalledTimes(2);
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

      // A bare id in, the resolved page out: tells `url` from the raw argument.
      const result = await validateAndCaptureVideoFrame({ url: 'dQw4w9WgXcQ' });

      expect(captureSpy).toHaveBeenCalledWith(
        url,
        0,
        { format: 'jpeg', width: 1280, quality: 4 },
        undefined
      );
      expect(result).toMatchObject({
        videoId: 'dQw4w9WgXcQ',
        url,
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

    const mockCaptureFailure = (): void => {
      jest.spyOn(youtube, 'captureVideoFrame').mockResolvedValue({
        ok: false,
        reason: 'capture_failed',
        videoId: 'dQw4w9WgXcQ',
        details: { message: 'Command failed: ffmpeg -i https://cdn.example/stream.mp4' },
      });
    };

    it('should map capture_failed to NotFoundError without the ffmpeg details', async () => {
      mockCaptureFailure();

      await expect(validateAndCaptureVideoFrame({ url, seconds: 10 })).rejects.toMatchObject({
        name: 'NotFoundError',
        errorLabel: 'Frame capture failed',
      });
      const err = await validateAndCaptureVideoFrame({ url, seconds: 10 }).catch(
        (e: Error) => e.message
      );
      expect(err).toContain('00:00:10.000');
      expect(err).not.toContain('ffmpeg');
      expect(err).not.toContain('cdn.example');
      expect(err).not.toContain('Command failed');
    });

    it('should offer an earlier timestamp only when there is one', async () => {
      mockCaptureFailure();

      const past = await validateAndCaptureVideoFrame({ url, seconds: 10 }).catch(
        (e: Error) => e.message
      );
      const zero = await validateAndCaptureVideoFrame({ url, seconds: 0 }).catch(
        (e: Error) => e.message
      );

      expect(past).toMatch(/earlier/i);
      // At 00:00:00.000 "retry with an earlier timestamp" is the same call again, which is
      // the loop this text exists to close.
      expect(zero).toContain('00:00:00.000');
      expect(zero).not.toMatch(/earlier/i);
      expect(zero).toContain('get_video_info');
    });

    it('should treat the default timestamp like an explicit zero', async () => {
      mockCaptureFailure();

      const explicit = await validateAndCaptureVideoFrame({ url, seconds: 0 }).catch(
        (e: Error) => e.message
      );
      const byDefault = await validateAndCaptureVideoFrame({ url }).catch((e: Error) => e.message);

      // Branching on request.seconds instead of the resolved timestamp passes the default
      // case and lies about the explicit one.
      expect(byDefault).toBe(explicit);
    });
  });
});

describe('the answer when no subtitles came back', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const NEXT_STEPS =
    /Do not repeat the same call|Do not retry|You may retry the same call once in a few minutes|To try a track auto-discovery skipped|Omit type and lang to let the server choose/g;

  const withTracks = (official: string[], auto: string[]): void => {
    jest.spyOn(youtube, 'fetchYtDlpJson').mockResolvedValue({
      id: 'dQw4w9WgXcQ',
      subtitles: Object.fromEntries(official.map((l) => [l, [{ ext: 'vtt', url: 'u' }]])),
      automatic_captions: Object.fromEntries(auto.map((l) => [l, [{ ext: 'vtt', url: 'u' }]])),
    } as any);
    jest.spyOn(youtube, 'downloadSubtitles').mockResolvedValue(null);
  };

  const whisperOff = (): void => {
    (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'off' });
  };

  const messageOf = async (request: Record<string, unknown>): Promise<string> =>
    validateAndDownloadSubtitles(request as any).then(
      () => 'no error',
      (e: Error) => e.message
    );

  beforeEach(() => {
    whisperOff();
    (whisperJobs.startOrReuseWhisperJob as jest.Mock).mockResolvedValue(null);
  });

  it('says how many tracks auto-discovery asked for, without claiming which', async () => {
    withTracks(['en'], ['ru']);

    const message = await messageOf({ url });

    expect(message).toContain('No subtitles could be downloaded');
    expect(message).toContain('at most 2');
    // "one official and one auto" would be false: with one list empty both attempts go
    // to the other one.
    expect(message).not.toMatch(/the best official and the best automatic/);
  });

  it('spends both attempts on one list when the other is empty', async () => {
    withTracks(['a', 'b', 'c'], []);
    const download = jest.spyOn(youtube, 'downloadSubtitles');

    await messageOf({ url });

    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls.every((call) => call[1] === 'official')).toBe(true);
  });

  it('separates a list it could not read from a list that is empty', async () => {
    withTracks(['en'], ['ru']);
    // The probe at the throw site re-reads the list; this is the read that fails.
    jest
      .spyOn(youtube, 'fetchYtDlpJson')
      .mockResolvedValueOnce({
        id: 'dQw4w9WgXcQ',
        subtitles: { en: [{ ext: 'vtt', url: 'u' }] },
        automatic_captions: { ru: [{ ext: 'vtt', url: 'u' }] },
      } as any)
      .mockResolvedValue(null);

    const unreadable = await messageOf({ url });

    expect(unreadable).toContain('could not be read');
    expect(unreadable).not.toContain('lists no subtitle tracks');
    await expect(validateAndDownloadSubtitles({ url } as any)).rejects.toMatchObject({
      details: undefined,
    });

    withTracks([], []);
    const empty = await messageOf({ url });
    expect(empty).toContain('lists no subtitle tracks');
    expect(empty).not.toContain('could not be read');
  });

  it('hands the track lists and the language just tried to the caller', async () => {
    withTracks(['en'], ['ru']);

    await expect(
      validateAndDownloadSubtitles({ url, type: 'auto', lang: 'ru' } as any)
    ).rejects.toMatchObject({
      errorLabel: 'Subtitles not found',
      statusCode: 404,
      details: { official: ['en'], auto: ['ru'], tried: 'ru' },
    });
  });

  it('names the values the server substituted, and only when it substituted them', async () => {
    withTracks(['en'], ['ru']);

    const oneGiven = await messageOf({ url, lang: 'ru' });
    const bothGiven = await messageOf({ url, type: 'auto', lang: 'ru' });

    expect(oneGiven).toContain('No auto subtitles could be downloaded for language "ru"');
    expect(oneGiven).toContain('defaults to type "auto" and lang "en"');
    expect(bothGiven).not.toContain('defaults to');
  });

  it('gives the caller exactly one next step, whatever the branch', async () => {
    const shapes: Array<Record<string, unknown>> = [
      { url },
      { url, type: 'auto', lang: 'ru' },
      { url, lang: 'ru' },
    ];

    for (const tracks of [
      [['en'], ['ru']],
      [[], []],
    ] as Array<[string[], string[]]>) {
      for (const shape of shapes) {
        withTracks(tracks[0], tracks[1]);
        const message = await messageOf(shape);
        expect(message.match(NEXT_STEPS) ?? []).toHaveLength(1);
      }
    }
  });

  it('offers the way out that fits the flow', async () => {
    withTracks(['en'], ['ru']);

    const auto = await messageOf({ url });
    const explicit = await messageOf({ url, type: 'auto', lang: 'ru' });

    expect(auto).toContain('pass type and lang explicitly');
    expect(auto).not.toContain('Omit type and lang');
    expect(explicit).toContain('Omit type and lang');
  });

  it('says this server does not transcribe audio when it does not', async () => {
    withTracks(['en'], ['ru']);

    const message = await messageOf({ url });

    expect(message).toContain('does not transcribe audio');
    expect(message).not.toContain('Speech-to-text');
  });

  it('lets the caller wait for speech-to-text only while it may still finish', async () => {
    withTracks([], []);
    (whisper.getWhisperConfig as jest.Mock).mockReturnValue({ mode: 'local', timeout: 600_000 });

    const running = await messageOf({ url });
    expect(running).toContain('may still finish in the background');
    expect(running).toContain('retry the same call once in a few minutes');

    process.env.WHISPER_MAX_DURATION_SECONDS = '120';
    try {
      const capped = await messageOf({ url });
      // With a ceiling the job will never run for this video again, so waiting is not the
      // step to offer.
      expect(capped).toContain('only videos up to 120 seconds long');
      expect(capped).not.toContain('retry the same call once in a few minutes');
    } finally {
      delete process.env.WHISPER_MAX_DURATION_SECONDS;
    }
  });

  it('names no route and no tool of its own', async () => {
    withTracks(['en'], ['ru']);

    for (const shape of [{ url }, { url, type: 'auto', lang: 'ru' }]) {
      const message = await messageOf(shape);
      // This text reaches REST verbatim, where an MCP tool name means nothing, and the
      // route it used to name is POST, not GET.
      expect(message).not.toContain('/subtitles/available');
      expect(message).not.toContain('get_available_subtitles');
      expect(message).not.toMatch(/GET |WHISPER_/);
    }
  });

  it('keeps a classified failure instead of reporting missing subtitles', async () => {
    withTracks(['en'], ['ru']);
    jest
      .spyOn(youtube, 'fetchYtDlpJson')
      .mockResolvedValueOnce({
        id: 'dQw4w9WgXcQ',
        subtitles: { en: [{ ext: 'vtt', url: 'u' }] },
        automatic_captions: {},
      } as any)
      .mockRejectedValue(new YtDlpError('private'));

    await expect(validateAndDownloadSubtitles({ url } as any)).rejects.toMatchObject({
      name: 'YtDlpError',
      reason: 'private',
    });
  });
});

describe('validateVideoRequest', () => {
  it('answers a rejected URL with the one sentence every tool uses', () => {
    expect(() => validateVideoRequest('https://example.com/video')).toThrow(
      INVALID_VIDEO_URL_MESSAGE
    );
    expect(() => validateVideoRequest('https://example.com/video')).toThrow(
      expect.objectContaining({ errorLabel: 'Invalid video URL' }) as unknown as Error
    );
  });
});
