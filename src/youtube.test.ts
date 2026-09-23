import { execFile } from 'node:child_process';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { access, constants, writeFile, unlink } from 'node:fs/promises';
import * as youtube from './youtube.js';
import {
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';
import { renderPrometheus } from './metrics.js';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

const {
  extractYouTubeVideoId,
  detectSubtitleFormat,
  parseSubtitles,
  downloadSubtitles,
  downloadPlaylistSubtitles,
  downloadAudio,
  fetchVideoInfo,
  fetchVideoChapters,
  fetchYtDlpJson,
  searchVideos,
  findSubtitleFile,
  getYtDlpEnv,
  appendYtDlpEnvArgs,
  appendYtDlpAudioArgs,
  appendYtDlpSubtitleArgs,
  resolveSubtitleFormat,
  ensureWritableCookiesFile,
  urlToSafeBase,
  collectExecFileErrorDetails,
  classifyYtDlpFailure,
  captureVideoFrame,
  getImageWidth,
} = youtube;

describe('youtube', () => {
  // The hold lives in a module-level map: a case that sets one would silently refuse
  // every later download in this file.
  beforeEach(() => {
    resetSubtitleRateLimitsForTests();
  });

  /** yt-dlp exits non-zero with this on stderr. `promisify` drops everything after the error. */
  function mockExecFileFailure(stderr: string, code = 1) {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        const error = new Error('Command failed: yt-dlp --cookies /cookies.txt') as Error & {
          code?: number;
          stderr?: string;
        };
        error.code = code;
        error.stderr = stderr;
        setImmediate(() => callback(error, { stdout: '', stderr }));
      }
    );
  }

  describe('extractYouTubeVideoId', () => {
    it('should extract video ID from standard YouTube URLs', () => {
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ'
      );
      expect(extractYouTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ'
      );
    });

    it('should extract video ID from URLs with additional parameters', () => {
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe(
        'dQw4w9WgXcQ'
      );
      expect(
        extractYouTubeVideoId('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ')
      ).toBe('dQw4w9WgXcQ');
    });

    it('should return null for non-YouTube URLs (multi-platform fallback semantics)', () => {
      expect(extractYouTubeVideoId('https://www.tiktok.com/@user/video/123')).toBeNull();
      expect(extractYouTubeVideoId('https://vimeo.com/123456')).toBeNull();
      expect(extractYouTubeVideoId('https://twitter.com/user/status/123')).toBeNull();
      expect(extractYouTubeVideoId('not-a-url')).toBeNull();
      expect(extractYouTubeVideoId('https://example.com')).toBeNull();
      expect(extractYouTubeVideoId('')).toBeNull();
    });
  });

  describe('detectSubtitleFormat', () => {
    it('should detect VTT format', () => {
      const vttContent = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world';
      expect(detectSubtitleFormat(vttContent)).toBe('vtt');
    });

    it('should detect SRT format', () => {
      const srtContent = '1\n00:00:00,000 --> 00:00:05,000\nHello world';
      expect(detectSubtitleFormat(srtContent)).toBe('srt');
    });

    it('should detect ASS format', () => {
      const assContent =
        '[Script Info]\nTitle: Test\n\n[Events]\nDialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,Hello world';
      expect(detectSubtitleFormat(assContent)).toBe('ass');
    });

    it('should detect LRC format', () => {
      const lrcContent = '[00:12.00]Hello world\n[00:24.50]This is a test';
      expect(detectSubtitleFormat(lrcContent)).toBe('lrc');
    });

    it('should default to SRT for content without WEBVTT header', () => {
      expect(detectSubtitleFormat('Some text')).toBe('srt');
      expect(detectSubtitleFormat('')).toBe('srt');
    });
  });

  describe('resolveSubtitleFormat', () => {
    const origEnv = process.env.YT_DLP_SUB_FORMAT;
    afterEach(() => {
      process.env.YT_DLP_SUB_FORMAT = origEnv;
    });

    it('should return param when valid', () => {
      expect(resolveSubtitleFormat('vtt')).toBe('vtt');
      expect(resolveSubtitleFormat('ass')).toBe('ass');
    });

    it('should return YT_DLP_SUB_FORMAT when param omitted', () => {
      process.env.YT_DLP_SUB_FORMAT = 'lrc';
      expect(resolveSubtitleFormat(undefined)).toBe('lrc');
    });

    it('should default to srt when neither param nor env set', () => {
      delete process.env.YT_DLP_SUB_FORMAT;
      expect(resolveSubtitleFormat(undefined)).toBe('srt');
    });
  });

  describe('parseSubtitles', () => {
    it('should parse SRT format correctly', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello world

2
00:00:05,000 --> 00:00:10,000
This is a test`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Hello world This is a test');
    });

    it('should parse VTT format correctly', () => {
      const vttContent = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello world

00:00:05.000 --> 00:00:10.000
This is a test`;

      const result = parseSubtitles(vttContent);
      expect(result).toBe('Hello world This is a test');
    });

    it('should parse ASS format correctly', () => {
      const assContent = `[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.00,0:00:10.00,Default,,0,0,0,,This is a test`;
      const result = parseSubtitles(assContent);
      expect(result).toBe('Hello world This is a test');
    });

    it('should parse LRC format correctly', () => {
      const lrcContent = `[00:12.00]Hello world
[00:24.50]This is a test`;
      const result = parseSubtitles(lrcContent);
      expect(result).toBe('Hello world This is a test');
    });

    it('should remove HTML tags from subtitles', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello <b>world</b>`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Hello world');
    });

    it('should remove sound labels from subtitles', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello [music] world [applause]`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Hello world');
    });

    it('should remove speaker markers from subtitles', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
>> Hello world`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Hello world');
    });

    it('should handle empty subtitles', () => {
      expect(parseSubtitles('')).toBe('');
      expect(parseSubtitles('WEBVTT')).toBe('');
    });

    it('should handle subtitles with only timestamps', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000

2
00:00:05,000 --> 00:00:10,000`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('');
    });

    it('should handle multiline subtitle text', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
Line one
Line two
Line three`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Line one Line two Line three');
    });

    it('should clean up multiple spaces', () => {
      const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello    world     test`;

      const result = parseSubtitles(srtContent);
      expect(result).toBe('Hello world test');
    });

    it('should handle complex VTT with metadata', () => {
      const vttContent = `WEBVTT
NOTE This is a note

00:00:00.000 --> 00:00:05.000
Hello world

00:00:05.000 --> 00:00:10.000
This is a test`;

      const result = parseSubtitles(vttContent);
      expect(result).toBe('Hello world This is a test');
    });

    it('should skip NOTE lines in VTT', () => {
      const vttContent = `WEBVTT
NOTE This is a note

00:00:00.000 --> 00:00:05.000
Hello world`;

      const result = parseSubtitles(vttContent);
      expect(result).toBe('Hello world');
    });

    it('should deduplicate word-by-word VTT cues with identical text', () => {
      const vttContent = `WEBVTT

00:00:00.000 --> 00:00:00.520
<u>Dearly</u> beloved, we are gathered here
today to pay our respects to MCP, which

00:00:00.520 --> 00:00:00.900
Dearly <u>beloved,</u> we are gathered here
today to pay our respects to MCP, which

00:00:05.000 --> 00:00:06.000
<u>This</u> is new phrase`;
      const result = parseSubtitles(vttContent);
      expect(result).toBe(
        'Dearly beloved, we are gathered here today to pay our respects to MCP, which This is new phrase'
      );
    });
  });

  describe('downloadSubtitleTrackDirect', () => {
    const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=x&fmt=vtt&lang=en';
    const data = {
      id: 'x',
      subtitles: { en: [{ ext: 'vtt', url: TIMEDTEXT }] },
      automatic_captions: {
        en: [
          // YouTube lists the auto track as an HLS manifest as well; it must be skipped.
          {
            ext: 'vtt',
            url: 'https://manifest.googlevideo.com/api/manifest/hls/playlist/index.m3u8',
          },
          { ext: 'vtt', url: TIMEDTEXT },
        ],
      },
    };
    let fetchMock: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    function answer(body: string, status = 200) {
      fetchMock.mockResolvedValue({ ok: status < 400, status, text: () => Promise.resolve(body) });
    }

    it('should fetch the track listed for the language and skip the HLS manifest', async () => {
      answer('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi');
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'auto', 'en', 'vtt')
      ).resolves.toContain('WEBVTT');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(TIMEDTEXT);
    });

    it('should ask as the browser yt-dlp claims to be', async () => {
      answer('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi');
      await youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'vtt');
      const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+\.0\.0\.0 Safari/);
      expect(headers['Accept-Language']).toBe('en-us,en;q=0.5');
    });

    it('should read only listed tracks, not Object.prototype', async () => {
      for (const lang of ['toString', 'constructor', 'hasOwnProperty']) {
        await expect(
          youtube.downloadSubtitleTrackDirect(data, 'official', lang, 'vtt')
        ).resolves.toBeNull();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should give up when the answer is not the requested subtitles', async () => {
      answer('<html>sign in</html>');
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'vtt')
      ).resolves.toBeNull();

      answer('WEBVTT', 403);
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'vtt')
      ).resolves.toBeNull();

      fetchMock.mockRejectedValue(new Error('network down'));
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'vtt')
      ).resolves.toBeNull();
    });

    it('should reject an error page that carries an HTML comment as srt', async () => {
      // srt is what detectSubtitleFormat calls anything it does not recognise, and every
      // HTML comment contains the "-->" a cue line also has.
      answer('<!DOCTYPE html><html><!-- consent gate --><body>Sign in</body></html>');
      await expect(
        youtube.downloadSubtitleTrackDirect(
          { subtitles: { en: [{ ext: 'srt', url: TIMEDTEXT }] } },
          'official',
          'en',
          'srt'
        )
      ).resolves.toBeNull();

      answer('1\n00:00:01,000 --> 00:00:02,000\nhi\n');
      await expect(
        youtube.downloadSubtitleTrackDirect(
          { subtitles: { en: [{ ext: 'srt', url: TIMEDTEXT }] } },
          'official',
          'en',
          'srt'
        )
      ).resolves.toContain('-->');
    });

    it('should leave the track to yt-dlp when a proxy is configured', async () => {
      process.env.YT_DLP_PROXY = 'http://proxy.invalid:3128';
      try {
        answer('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi');
        await expect(
          youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'vtt')
        ).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        delete process.env.YT_DLP_PROXY;
      }
    });

    it('should not fetch anything when the format or language is not listed', async () => {
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'official', 'en', 'srt')
      ).resolves.toBeNull();
      await expect(
        youtube.downloadSubtitleTrackDirect(data, 'official', 'ru', 'vtt')
      ).resolves.toBeNull();
      await expect(
        youtube.downloadSubtitleTrackDirect(null, 'official', 'en', 'vtt')
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should let downloadSubtitles answer without running yt-dlp', async () => {
      answer('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi');
      const content = await youtube.downloadSubtitles(
        'https://www.youtube.com/watch?v=x',
        'official',
        'en',
        'vtt',
        undefined,
        data
      );
      expect(content).toContain('WEBVTT');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('should fall back to yt-dlp when the direct fetch gives nothing', async () => {
      answer('nope', 500);
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => callback(new Error('yt-dlp ran'))
      );
      await youtube.downloadSubtitles(
        'https://www.youtube.com/watch?v=x',
        'official',
        'en',
        'vtt',
        undefined,
        data
      );
      expect(execFileMock).toHaveBeenCalled();
    });
  });

  describe('downloadSubtitles', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return subtitles content and remove file on successful download', async () => {
      const url = 'https://www.youtube.com/watch?v=video123';
      const content = 'subtitle content';

      const timestamp = 1234567890;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'subtitles');
      const subtitleFileName = `${baseName}.en.srt`;
      const subtitleFilePath = join(tempDir, subtitleFileName);

      await writeFile(subtitleFilePath, content, 'utf-8');

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      const result = await downloadSubtitles(url, 'auto', 'en');

      expect(execFileMock).toHaveBeenCalled();
      expect(result).toBe(content);
      await expect(access(subtitleFilePath, constants.F_OK)).rejects.toThrow();

      dateSpy.mockRestore();
    });

    it('should return null when no subtitle file is found', async () => {
      const url = 'https://www.youtube.com/watch?v=video-no-file';
      const timestamp = 1234567891;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'subtitles');
      const subtitleFileName = `${baseName}.en.srt`;
      const subtitleFilePath = join(tempDir, subtitleFileName);

      await unlink(subtitleFilePath).catch(() => {});

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      const result = await downloadSubtitles(url, 'auto', 'en');

      expect(result).toBeNull();

      dateSpy.mockRestore();
    });

    it('should return null when subtitle file is empty', async () => {
      const url = 'https://www.youtube.com/watch?v=video-empty';
      const content = '   ';
      const timestamp = 1234567892;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'subtitles');
      const subtitleFileName = `${baseName}.en.srt`;
      const subtitleFilePath = join(tempDir, subtitleFileName);

      await writeFile(subtitleFilePath, content, 'utf-8');

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      const result = await downloadSubtitles(url, 'auto', 'en');

      expect(result).toBeNull();
      await expect(access(subtitleFilePath, constants.F_OK)).resolves.toBeUndefined();

      dateSpy.mockRestore();
    });

    it('should still return content when yt-dlp fails but file exists', async () => {
      const url = 'https://www.youtube.com/watch?v=video123';
      const content = 'subtitle content after error';

      const timestamp = 1234567893;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'subtitles');
      const subtitleFileName = `${baseName}.en.srt`;
      const subtitleFilePath = join(tempDir, subtitleFileName);

      await writeFile(subtitleFilePath, content, 'utf-8');

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          const error = new Error('yt-dlp error') as any;
          error.stdout = '';
          error.stderr = 'error';
          callback(error, { stdout: '', stderr: 'error' });
        }
      );

      const result = await downloadSubtitles(url, 'auto', 'en');

      expect(result).toBe(content);
      await expect(access(subtitleFilePath, constants.F_OK)).rejects.toThrow();

      dateSpy.mockRestore();
    });
  });

  describe('downloadSubtitles under a platform rate limit', () => {
    const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=x&fmt=vtt&lang=en';
    const data = { id: 'x', subtitles: { en: [{ ext: 'vtt', url: TIMEDTEXT }] } };
    const CUE = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi';
    let fetchMock: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    async function captionRequests(labels: string): Promise<number> {
      const line = (await renderPrometheus())
        .split('\n')
        .find((l) => l.startsWith(`subtitle_requests_total{${labels}`));
      return line ? Number(line.split(' ').pop()) : 0;
    }

    async function seriesExists(labels: string): Promise<boolean> {
      return (await renderPrometheus())
        .split('\n')
        .some((l) => l.startsWith(`subtitle_requests_total{${labels}`));
    }

    it('gives a platform every outcome before it asks, so a refusal reads as a step', async () => {
      // Vimeo is untouched by the other cases here, so the series cannot pre-exist.
      const refused = 'platform="vimeo",path="direct",outcome="rate_limited"';
      expect(await seriesExists(refused)).toBe(false);

      execFileMock.mockImplementation(
        (
          _f: string,
          _a: string[],
          _o: unknown,
          cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => setImmediate(() => cb(null, { stdout: '', stderr: '' }))
      );
      await youtube.downloadSubtitles('https://vimeo.com/76979871', 'auto', 'en');

      // A refusal has something to be a step from now: an alert on increase() over a series
      // born at 1 sees a flat line, which is how the 429 of 2026-09-23 went unreported.
      expect(await seriesExists(refused)).toBe(true);
      expect(await captionRequests(refused)).toBe(0);
    });

    it('counts what it spends on the caption endpoint, by path, and nothing else', async () => {
      const direct429 = 'platform="youtube",path="direct",outcome="rate_limited"';
      const ytDlpOk = 'platform="youtube",path="yt_dlp",outcome="ok"';
      const before = {
        direct: await captionRequests(direct429),
        ytDlp: await captionRequests(ytDlpOk),
      };

      // One request to the endpoint, refused.
      fetchMock.mockResolvedValue({ ok: false, status: 429, text: () => Promise.resolve('') });
      await youtube
        .downloadSubtitles(
          'https://www.youtube.com/watch?v=x',
          'official',
          'en',
          'vtt',
          undefined,
          data
        )
        .catch(() => undefined);
      expect(await captionRequests(direct429)).toBe(before.direct + 1);
      // The yt-dlp run never happened, so it must not be counted.
      expect(await captionRequests(ytDlpOk)).toBe(before.ytDlp);

      // One yt-dlp run that reached the platform and came back without a track.
      resetSubtitleRateLimitsForTests();
      execFileMock.mockImplementation(
        (
          _f: string,
          _a: string[],
          _o: unknown,
          cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => setImmediate(() => cb(null, { stdout: '', stderr: '' }))
      );
      await youtube.downloadSubtitles('https://www.youtube.com/watch?v=p', 'auto', 'en');
      expect(await captionRequests(ytDlpOk)).toBe(before.ytDlp + 1);

      // A yt-dlp run the platform refuses: the series that says which path hit the limit.
      const ytDlp429 = 'platform="youtube",path="yt_dlp",outcome="rate_limited"';
      const beforeRefused = await captionRequests(ytDlp429);
      resetSubtitleRateLimitsForTests();
      mockExecFileFailure('ERROR: HTTP Error 429: Too Many Requests');
      await youtube
        .downloadSubtitles('https://www.youtube.com/watch?v=r', 'auto', 'en')
        .catch(() => undefined);
      expect(await captionRequests(ytDlp429)).toBe(beforeRefused + 1);
      expect(await captionRequests(ytDlpOk)).toBe(before.ytDlp + 1);
    });

    it('answers the next call for that platform without spending a request', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 429, text: () => Promise.resolve('') });

      // A 429 on the track URL is the platform's answer for the whole platform: reported
      // as a rate limit, and without handing the doomed request on to yt-dlp.
      await expect(
        youtube.downloadSubtitles(
          'https://www.youtube.com/watch?v=x',
          'official',
          'en',
          'vtt',
          undefined,
          data
        )
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
      expect(execFileMock).not.toHaveBeenCalled();
      fetchMock.mockClear();

      // Another spelling of the same platform: the limit is the platform's, not the URL's.
      await expect(
        youtube.downloadSubtitles('https://youtu.be/y', 'official', 'en', 'vtt', undefined, data)
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('asks again once the wait is over, and a download clears the limit', async () => {
      const t0 = 1_700_000_000_000;
      const minute = 60 * 1000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const call = () =>
        youtube.downloadSubtitles(
          'https://www.youtube.com/watch?v=x',
          'official',
          'en',
          'vtt',
          undefined,
          data
        );
      const refuse = () =>
        fetchMock.mockResolvedValue({ ok: false, status: 429, text: () => Promise.resolve('') });
      const answerCue = () =>
        fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(CUE) });

      refuse();
      await call().catch(() => undefined);

      dateSpy.mockReturnValue(t0 + 11 * minute);
      answerCue();
      await expect(call()).resolves.toContain('WEBVTT');

      // The download cleared the count, so a later 429 waits the base time again and not
      // twice it: without the clear this call would still be held back at +22 minutes.
      refuse();
      await call().catch(() => undefined);
      dateSpy.mockReturnValue(t0 + 22 * minute);
      answerCue();
      await expect(call()).resolves.toContain('WEBVTT');
      dateSpy.mockRestore();
    });

    it('clears the limit only when yt-dlp brings back a track', async () => {
      const t0 = 1_700_000_000_000;
      const minute = 60 * 1000;
      const url = 'https://www.youtube.com/watch?v=q';
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      type Cb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
      const refuse = () => mockExecFileFailure('ERROR: HTTP Error 429: Too Many Requests');
      // yt-dlp writes the track next to the output path, which carries the current clock.
      const answerWithTrack = async () => {
        await writeFile(
          join(tmpdir(), `${urlToSafeBase(url, 'subtitles')}.en.srt`),
          '1\n00:00:01,000 --> 00:00:02,000\nhi\n',
          'utf-8'
        );
        execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Cb) =>
          setImmediate(() => cb(null, { stdout: '', stderr: '' }))
        );
      };
      const call = () => youtube.downloadSubtitles(url, 'auto', 'en');

      refuse();
      await call().catch(() => undefined);

      dateSpy.mockReturnValue(t0 + 11 * minute);
      await answerWithTrack();
      await expect(call()).resolves.toContain('hi');

      // Cleared: a later limit waits the base time again, not twice it.
      refuse();
      await call().catch(() => undefined);
      dateSpy.mockReturnValue(t0 + 22 * minute);
      await answerWithTrack();
      await expect(call()).resolves.toContain('hi');
      dateSpy.mockRestore();
    });

    it('keeps the limit when yt-dlp answers without a track', async () => {
      const t0 = 1_700_000_000_000;
      const minute = 60 * 1000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      type Cb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
      mockExecFileFailure('ERROR: HTTP Error 429: Too Many Requests');
      await youtube
        .downloadSubtitles('https://www.youtube.com/watch?v=n', 'auto', 'en')
        .catch(() => undefined);

      // A run that finds no file may never have asked the caption endpoint at all.
      dateSpy.mockReturnValue(t0 + 11 * minute);
      execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Cb) =>
        setImmediate(() => cb(null, { stdout: '', stderr: '' }))
      );
      await expect(
        youtube.downloadSubtitles('https://www.youtube.com/watch?v=n', 'auto', 'en')
      ).resolves.toBeNull();

      mockExecFileFailure('ERROR: HTTP Error 429: Too Many Requests');
      await youtube
        .downloadSubtitles('https://www.youtube.com/watch?v=n', 'auto', 'en')
        .catch(() => undefined);
      // Second strike, so the wait is 20 minutes: still held 11 minutes later, and being
      // held means no process runs — a cleared count would have let this call through.
      dateSpy.mockReturnValue(t0 + 22 * minute);
      execFileMock.mockClear();
      await expect(
        youtube.downloadSubtitles('https://www.youtube.com/watch?v=n', 'auto', 'en')
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
      expect(execFileMock).not.toHaveBeenCalled();
      dateSpy.mockRestore();
    });

    it('holds the platform back after yt-dlp itself is rate-limited', async () => {
      mockExecFileFailure(
        'ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests'
      );

      await expect(
        youtube.downloadSubtitles('https://www.youtube.com/watch?v=z', 'auto', 'en')
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });

      execFileMock.mockClear();
      await expect(
        youtube.downloadSubtitles('https://www.youtube.com/watch?v=z2', 'auto', 'en')
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  describe('downloadAudio', () => {
    const url = 'https://www.youtube.com/watch?v=audio123';

    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.YT_DLP_AUDIO_FORMAT;
      delete process.env.YT_DLP_AUDIO_QUALITY;
      delete process.env.YT_DLP_AUDIO_TIMEOUT;
      delete process.env.YT_DLP_TIMEOUT;
      delete process.env.YT_DLP_AUDIO_CONCURRENT_FRAGMENTS;
      delete process.env.YT_DLP_AUDIO_LIMIT_RATE;
      delete process.env.YT_DLP_AUDIO_RETRIES;
      delete process.env.WHISPER_MAX_DURATION_SECONDS;
    });

    it('should pass format and audio-quality to yt-dlp and return path to audio file', async () => {
      const timestamp = 1234567894;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'audio');
      const audioFilePath = join(tempDir, `${baseName}.m4a`);
      await writeFile(audioFilePath, 'fake audio', 'utf-8');

      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          expect(file).toBe('yt-dlp');
          capturedArgs = args;
          callback(null, { stdout: '', stderr: '' });
        }
      );

      const result = await downloadAudio(url);

      expect(execFileMock).toHaveBeenCalled();
      expect(capturedArgs).toContain('-f');
      expect(capturedArgs).toContain('bestaudio[abr<=192]/bestaudio');
      expect(capturedArgs).toContain('--audio-quality');
      expect(capturedArgs).toContain('5');
      expect(capturedArgs).toContain('--extract-audio');
      expect(capturedArgs).toContain('--audio-format');
      expect(capturedArgs).toContain('m4a');
      expect(result).toBe(audioFilePath);

      await unlink(audioFilePath).catch(() => {});
      dateSpy.mockRestore();
    });

    it('should use YT_DLP_AUDIO_FORMAT and YT_DLP_AUDIO_QUALITY when set', async () => {
      process.env.YT_DLP_AUDIO_FORMAT = 'bestaudio[abr<=128]/ba';
      process.env.YT_DLP_AUDIO_QUALITY = '7';
      const timestamp = 1234567895;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'audio');
      const audioFilePath = join(tempDir, `${baseName}.m4a`);
      await writeFile(audioFilePath, 'fake audio', 'utf-8');

      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedArgs = args;
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await downloadAudio(url);

      const formatIdx = capturedArgs.indexOf('-f');
      expect(capturedArgs[formatIdx + 1]).toBe('bestaudio[abr<=128]/ba');
      const qualityIdx = capturedArgs.indexOf('--audio-quality');
      expect(capturedArgs[qualityIdx + 1]).toBe('7');

      await unlink(audioFilePath).catch(() => {});
      dateSpy.mockRestore();
    });

    it('should use YT_DLP_AUDIO_TIMEOUT when set, else YT_DLP_TIMEOUT', async () => {
      const timestamp = 1234567896;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'audio');
      const audioFilePath = join(tempDir, `${baseName}.m4a`);
      await writeFile(audioFilePath, 'fake audio', 'utf-8');

      let capturedOptions: { timeout?: number } = {};
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          options: { timeout?: number },
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedOptions = options;
          callback(null, { stdout: '', stderr: '' });
        }
      );

      process.env.YT_DLP_AUDIO_TIMEOUT = '900000';
      await downloadAudio(url);
      expect(capturedOptions.timeout).toBe(900000);
      await unlink(audioFilePath).catch(() => {});

      delete process.env.YT_DLP_AUDIO_TIMEOUT;
      process.env.YT_DLP_TIMEOUT = '120000';
      await writeFile(audioFilePath, 'fake audio', 'utf-8');
      await downloadAudio(url);
      expect(capturedOptions.timeout).toBe(120000);
      await unlink(audioFilePath).catch(() => {});

      delete process.env.YT_DLP_TIMEOUT;
      await writeFile(audioFilePath, 'fake audio', 'utf-8');
      await downloadAudio(url);
      expect(capturedOptions.timeout).toBe(60000);

      await unlink(audioFilePath).catch(() => {});
      dateSpy.mockRestore();
    });

    it('should pass YT_DLP_AUDIO_CONCURRENT_FRAGMENTS and YT_DLP_AUDIO_LIMIT_RATE to yt-dlp when set', async () => {
      process.env.YT_DLP_AUDIO_CONCURRENT_FRAGMENTS = '4';
      process.env.YT_DLP_AUDIO_LIMIT_RATE = '4M';
      const timestamp = 1234567897;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const tempDir = tmpdir();
      const baseName = urlToSafeBase(url, 'audio');
      const audioFilePath = join(tempDir, `${baseName}.m4a`);
      await writeFile(audioFilePath, 'fake audio', 'utf-8');

      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedArgs = args;
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await downloadAudio(url);

      const nIdx = capturedArgs.indexOf('-N');
      expect(nIdx).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[nIdx + 1]).toBe('4');
      const rIdx = capturedArgs.indexOf('-r');
      expect(rIdx).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[rIdx + 1]).toBe('4M');

      await unlink(audioFilePath).catch(() => {});
      dateSpy.mockRestore();
    });

    it('should cap the video length only when WHISPER_MAX_DURATION_SECONDS is set', async () => {
      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedArgs = args;
          callback(null, { stdout: '', stderr: '' });
        }
      );
      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

      await downloadAudio('https://www.youtube.com/watch?v=nocap1', logger as any);
      expect(capturedArgs).not.toContain('--match-filter');
      expect(logger.error).toHaveBeenCalledWith(
        expect.anything(),
        'Audio file not found after yt-dlp'
      );

      process.env.WHISPER_MAX_DURATION_SECONDS = '120';
      logger.error.mockClear();
      // yt-dlp skipped the video: exit code 0, no file
      const result = await downloadAudio('https://www.youtube.com/watch?v=capped1', logger as any);

      const idx = capturedArgs.indexOf('--match-filter');
      expect(capturedArgs[idx + 1]).toBe('!is_live & duration <=? 120');
      expect(result).toBeNull();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { maxDuration: 120 },
        'No audio for Whisper: video too long or of unknown length'
      );
    });

    it('measures the downloaded audio with ffprobe when the platform reports no length', async () => {
      process.env.WHISPER_MAX_DURATION_SECONDS = '120';
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1234567895);
      const reel = 'https://www.instagram.com/reel/abc123/';
      const audioFilePath = join(tmpdir(), `${urlToSafeBase(reel, 'audio')}.m4a`);
      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
      let probeArgs: string[] = [];
      const run = (probe: string | Error) => {
        execFileMock.mockImplementation(
          (
            file: string,
            args: string[],
            _options: unknown,
            callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
          ) => {
            if (file === 'ffprobe') {
              probeArgs = args;
              if (probe instanceof Error) callback(probe, { stdout: '', stderr: 'Invalid data' });
              else callback(null, { stdout: probe, stderr: '' });
              return;
            }
            void writeFile(audioFilePath, 'fake audio', 'utf-8').then(() =>
              callback(null, { stdout: '', stderr: '' })
            );
          }
        );
        return downloadAudio(reel, logger as any);
      };

      // Longer than the cap: the file is dropped and the caller sees "no audio".
      expect(await run('200.5\n')).toBeNull();
      expect(probeArgs[probeArgs.length - 1]).toBe(audioFilePath);
      await expect(access(audioFilePath, constants.F_OK)).rejects.toThrow();
      expect(logger.info).toHaveBeenCalledWith(
        { maxDuration: 120, duration: 200.5 },
        'No audio for Whisper: video too long or of unknown length'
      );

      // ffprobe itself fails (unreadable file, or missing binary on a self-host): still
      // dropped, so the cap stays a cap, but the warn says which of the two it was.
      expect(await run(new Error('ffprobe exited 1'))).toBeNull();
      await expect(access(audioFilePath, constants.F_OK)).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        { error: 'ffprobe exited 1' },
        'ffprobe could not read the downloaded audio'
      );

      // Whole seconds, like yt-dlp's own integer duration: a 120 s video whose audio
      // track runs a fraction longer is not over a 120 s cap.
      expect(await run('120.31\n')).toBe(audioFilePath);

      // Within the cap: the file is handed on.
      expect(await run('12.679\n')).toBe(audioFilePath);
      await unlink(audioFilePath).catch(() => {});
      dateSpy.mockRestore();
    });

    it('reads the length even when the process cap is full', async () => {
      // Fails if the probe goes under the process cap (see probeDurationSeconds).
      process.env.WHISPER_MAX_DURATION_SECONDS = '120';
      process.env.YT_DLP_MAX_CONCURRENCY = '1';
      process.env.YT_DLP_MAX_QUEUE = '0';
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1234567896);
      const reel = 'https://www.instagram.com/reel/busy1/';
      const audioFilePath = join(tmpdir(), `${urlToSafeBase(reel, 'audio')}.m4a`);
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      const releases: Array<() => void> = [];
      // The download's output, staged up front so releasing a slot stays synchronous.
      await writeFile(audioFilePath, 'fake audio', 'utf-8');

      execFileMock.mockImplementation(
        (
          file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (file === 'ffprobe') {
            callback(null, { stdout: '12.679\n', stderr: '' });
            return;
          }
          releases.push(() => callback(null, { stdout: '{"id":"busy1"}', stderr: '' }));
        }
      );

      const first = downloadAudio(reel);
      await tick();
      releases.shift()?.(); // the download finishes and hands the only slot back
      await tick();
      await tick();
      const hog = fetchYtDlpJson('https://www.youtube.com/watch?v=hog1').catch(() => null);
      await tick(); // taken again, and the queue is at its limit of zero
      expect(execFileMock).toHaveBeenCalledTimes(2); // the hog is running, not refused

      expect(await first).toBe(audioFilePath);

      releases.shift()?.();
      await hog;
      await unlink(audioFilePath).catch(() => {});
      delete process.env.YT_DLP_MAX_CONCURRENCY;
      delete process.env.YT_DLP_MAX_QUEUE;
      dateSpy.mockRestore();
    });
  });

  describe('findSubtitleFile', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should find file that starts with base name and has subtitle extension', async () => {
      const tempDir = tmpdir();
      const basePath = join(tempDir, 'subtitles_video123_1');
      const baseName = basename(basePath);
      const subtitleFilePath = join(tempDir, `${baseName}.en.srt`);

      await writeFile(subtitleFilePath, 'dummy', 'utf-8');
      await writeFile(join(tempDir, 'other.txt'), 'other', 'utf-8');

      const result = await findSubtitleFile(basePath, tempDir);

      expect(result).toBe(subtitleFilePath);
    });

    it('should return null when no suitable files are found', async () => {
      const tempDir = tmpdir();
      const basePath = join(tempDir, 'subtitles_video123_2');

      await writeFile(join(tempDir, 'file.txt'), 'file', 'utf-8');

      const result = await findSubtitleFile(basePath, tempDir);

      expect(result).toBeNull();
    });
  });

  describe('getYtDlpEnv and appendYtDlpEnvArgs', () => {
    afterEach(() => {
      delete process.env.YT_DLP_JS_RUNTIMES;
      delete process.env.YT_DLP_REMOTE_COMPONENTS;
      delete process.env.COOKIES_FILE_PATH;
      delete process.env.YT_DLP_PROXY;
      delete process.env.YT_DLP_RETRIES;
      delete process.env.YT_DLP_RETRY_SLEEP;
      delete process.env.YT_DLP_SLEEP_REQUESTS;
      delete process.env.YT_DLP_SLEEP_INTERVAL;
      delete process.env.YT_DLP_MAX_SLEEP_INTERVAL;
      delete process.env.YT_DLP_SLEEP_SUBTITLES;
      delete process.env.YT_DLP_EXTRA_ARGS;
      delete process.env.YT_DLP_NO_WARNINGS;
    });

    it('should read and trim environment variables for yt-dlp', () => {
      process.env.YT_DLP_JS_RUNTIMES = ' node ';
      process.env.YT_DLP_REMOTE_COMPONENTS = ' custom ';
      process.env.COOKIES_FILE_PATH = ' /path/to/cookies.txt ';
      process.env.YT_DLP_PROXY = ' http://proxy:8080 ';

      const env = getYtDlpEnv();

      expect(env).toEqual({
        jsRuntimes: 'node',
        remoteComponents: 'custom',
        cookiesFilePathFromEnv: '/path/to/cookies.txt',
        proxyFromEnv: 'http://proxy:8080',
      });
    });

    it('should provide default remoteComponents when not set', () => {
      const env = getYtDlpEnv();

      expect(env.remoteComponents).toBe('ejs:github');
    });

    it('should append yt-dlp flags to be placed before the URL argument', () => {
      const baseArgs = ['--dump-single-json', '--skip-download'];
      const optionalArgs: string[] = [];
      const url = 'https://example.com';

      const env = {
        jsRuntimes: 'node',
        remoteComponents: 'ejs:github',
        cookiesFilePathFromEnv: '/cookies.txt',
        proxyFromEnv: 'socks5://127.0.0.1:9050',
      };

      appendYtDlpEnvArgs(optionalArgs, env);
      const args = [...baseArgs, ...optionalArgs, url];

      expect(args).toEqual([
        '--dump-single-json',
        '--skip-download',
        '--no-progress',
        '--quiet',
        '--cookies',
        '/cookies.txt',
        '--proxy',
        'socks5://127.0.0.1:9050',
        '--js-runtimes',
        'node',
        '--remote-components',
        'ejs:github',
        'https://example.com',
      ]);
    });

    it('should return original path when cookies file is writable', async () => {
      const writablePath = join(tmpdir(), 'cookies_writable.txt');
      await writeFile(writablePath, '# Netscape\n', 'utf-8');

      const { path, cleanup } = await ensureWritableCookiesFile(writablePath);

      expect(path).toBe(writablePath);
      await cleanup();
      await expect(access(writablePath, constants.F_OK)).resolves.toBeUndefined();
      await unlink(writablePath).catch(() => {});
    });

    it('should copy to temp when cookies file is read-only and cleanup removes temp', async () => {
      const readOnlyPath = join(tmpdir(), 'cookies_readonly.txt');
      await writeFile(readOnlyPath, '# Netscape\n', 'utf-8');
      const { chmod } = await import('node:fs/promises');
      await chmod(readOnlyPath, 0o444);

      const { path, cleanup } = await ensureWritableCookiesFile(readOnlyPath);

      expect(path).not.toBe(readOnlyPath);
      expect(path).toContain(tmpdir());
      expect(path).toMatch(/cookies_\d+_.*\.txt$/);
      await expect(access(path, constants.F_OK)).resolves.toBeUndefined();
      await cleanup();
      await expect(access(path, constants.F_OK)).rejects.toThrow();
      await chmod(readOnlyPath, 0o644);
      await unlink(readOnlyPath).catch(() => {});
    });

    it('should add --proxy when proxyFromEnv is set and omit when unset', () => {
      const baseArgs = ['--skip-download'];
      const url = 'https://example.com';

      const optionalWithProxy: string[] = [];
      appendYtDlpEnvArgs(optionalWithProxy, {
        proxyFromEnv: 'http://user:pass@proxy:8080',
      });
      expect([...baseArgs, ...optionalWithProxy, url]).toEqual([
        '--skip-download',
        '--no-progress',
        '--quiet',
        '--proxy',
        'http://user:pass@proxy:8080',
        'https://example.com',
      ]);

      const optionalWithoutProxy: string[] = [];
      appendYtDlpEnvArgs(optionalWithoutProxy, {});
      expect([...baseArgs, ...optionalWithoutProxy, url]).toEqual([
        '--skip-download',
        '--no-progress',
        '--quiet',
        'https://example.com',
      ]);
    });

    it('should add -R and --retry-sleep when YT_DLP_RETRIES and YT_DLP_RETRY_SLEEP are set', () => {
      process.env.YT_DLP_RETRIES = '15';
      process.env.YT_DLP_RETRY_SLEEP = 'linear=1::2';
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(optionalArgs, {});
      const args = ['--skip-download', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('-R');
      expect(args).toContain('15');
      expect(args).toContain('--retry-sleep');
      expect(args).toContain('linear=1::2');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should add YT_DLP_EXTRA_ARGS when set', () => {
      process.env.YT_DLP_EXTRA_ARGS = '--no-check-certificate -v';
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(optionalArgs, {});
      const args = ['--skip-download', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('--no-check-certificate');
      expect(args).toContain('-v');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should add --no-warnings when YT_DLP_NO_WARNINGS is 1', () => {
      process.env.YT_DLP_NO_WARNINGS = '1';
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(optionalArgs, {});
      const args = ['--skip-download', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('--no-warnings');
      expect(args).toContain('--no-progress');
      expect(args).toContain('--quiet');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should add sleep options when env vars are set', () => {
      process.env.YT_DLP_SLEEP_REQUESTS = '1';
      process.env.YT_DLP_SLEEP_INTERVAL = '2';
      process.env.YT_DLP_MAX_SLEEP_INTERVAL = '10';
      process.env.YT_DLP_SLEEP_SUBTITLES = '1';
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(optionalArgs, {});
      const args = ['--skip-download', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('--sleep-requests');
      expect(args).toContain('1');
      expect(args).toContain('--sleep-interval');
      expect(args).toContain('2');
      expect(args).toContain('--max-sleep-interval');
      expect(args).toContain('10');
      expect(args).toContain('--sleep-subtitles');
      expect(args).toContain('1');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should omit --no-progress and --quiet when opts.quiet is false', () => {
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(optionalArgs, {}, { quiet: false });
      expect(optionalArgs).not.toContain('--quiet');
      expect(optionalArgs).not.toContain('--no-progress');
    });
  });

  describe('appendYtDlpSubtitleArgs', () => {
    afterEach(() => {
      delete process.env.YT_DLP_ENCODING;
    });

    it('should add --encoding when YT_DLP_ENCODING is set', () => {
      process.env.YT_DLP_ENCODING = 'utf-8';
      const optionalArgs: string[] = [];
      appendYtDlpSubtitleArgs(optionalArgs);
      const args = ['--sub-format', 'srt', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('--encoding');
      expect(args).toContain('utf-8');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should not add --encoding when YT_DLP_ENCODING is unset', () => {
      const optionalArgs: string[] = [];
      appendYtDlpSubtitleArgs(optionalArgs);

      expect(optionalArgs).not.toContain('--encoding');
    });
  });

  describe('appendYtDlpAudioArgs', () => {
    afterEach(() => {
      delete process.env.YT_DLP_AUDIO_CONCURRENT_FRAGMENTS;
      delete process.env.YT_DLP_AUDIO_LIMIT_RATE;
      delete process.env.YT_DLP_AUDIO_THROTTLED_RATE;
      delete process.env.YT_DLP_AUDIO_RETRIES;
      delete process.env.YT_DLP_AUDIO_FRAGMENT_RETRIES;
      delete process.env.YT_DLP_AUDIO_RETRY_SLEEP;
      delete process.env.YT_DLP_AUDIO_BUFFER_SIZE;
      delete process.env.YT_DLP_AUDIO_HTTP_CHUNK_SIZE;
      delete process.env.YT_DLP_AUDIO_DOWNLOADER;
      delete process.env.YT_DLP_AUDIO_DOWNLOADER_ARGS;
    });

    it('should add audio-specific args when env vars are set', () => {
      process.env.YT_DLP_AUDIO_CONCURRENT_FRAGMENTS = '8';
      process.env.YT_DLP_AUDIO_LIMIT_RATE = '2M';
      process.env.YT_DLP_AUDIO_FRAGMENT_RETRIES = '20';
      const optionalArgs: string[] = [];
      appendYtDlpAudioArgs(optionalArgs);
      const args = ['-f', 'bestaudio', ...optionalArgs, 'https://example.com'];

      expect(args).toContain('-N');
      expect(args).toContain('8');
      expect(args).toContain('-r');
      expect(args).toContain('2M');
      expect(args).toContain('--fragment-retries');
      expect(args).toContain('20');
      expect(args.at(-1)).toBe('https://example.com');
    });

    it('should not add args when no audio env vars are set', () => {
      const optionalArgs: string[] = [];
      appendYtDlpAudioArgs(optionalArgs);

      expect(optionalArgs).toEqual([]);
    });
  });

  describe('fetchVideoChapters', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should use preFetchedData when provided and not call fetchYtDlpJson', async () => {
      const url = 'https://www.youtube.com/watch?v=video123';
      const preFetchedData = {
        id: 'video123',
        chapters: [
          { start_time: 0, end_time: 60, title: 'Intro' },
          { start_time: 60, end_time: 120, title: 'Main' },
        ],
      };

      const result = await fetchVideoChapters(url, undefined, preFetchedData);

      expect(execFileMock).not.toHaveBeenCalled();
      expect(result).toEqual([
        { startTime: 0, endTime: 60, title: 'Intro' },
        { startTime: 60, endTime: 120, title: 'Main' },
      ]);
    });

    it('should return an empty list for a video without chapters', async () => {
      const result = await fetchVideoChapters('https://www.youtube.com/watch?v=x', undefined, {
        id: 'x',
        chapters: null as unknown as undefined,
      });
      expect(result).toEqual([]);
    });

    it('should return null when preFetchedData is null', async () => {
      const result = await fetchVideoChapters('https://www.youtube.com/watch?v=x', undefined, null);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('fetchYtDlpJson and fetchVideoInfo', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.YT_DLP_IGNORE_NO_FORMATS;
    });

    it('should pass --quiet, --no-progress and --ignore-no-formats-error to yt-dlp by default', async () => {
      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedArgs = args;
          callback(null, { stdout: JSON.stringify({ id: 'v1', title: 'T' }), stderr: '' });
        }
      );

      await fetchYtDlpJson('https://www.youtube.com/watch?v=v1');

      expect(capturedArgs).toContain('--quiet');
      expect(capturedArgs).toContain('--no-progress');
      expect(capturedArgs).toContain('--ignore-no-formats-error');
    });

    it('should not pass --ignore-no-formats-error when YT_DLP_IGNORE_NO_FORMATS is 0', async () => {
      process.env.YT_DLP_IGNORE_NO_FORMATS = '0';
      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          capturedArgs = args;
          callback(null, { stdout: JSON.stringify({ id: 'v1', title: 'T' }), stderr: '' });
        }
      );

      await fetchYtDlpJson('https://www.youtube.com/watch?v=v1');

      expect(capturedArgs).not.toContain('--ignore-no-formats-error');
    });

    it('should return parsed JSON from yt-dlp', async () => {
      const url = 'https://www.youtube.com/watch?v=video123';
      const ytDlpJson = {
        id: 'video123',
        title: 'Test title',
        duration: 120,
        view_count: 10,
      };

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: JSON.stringify(ytDlpJson), stderr: '' });
        }
      );

      const result = await fetchYtDlpJson(url);

      expect(result).toEqual(ytDlpJson);
    });

    it('should return null when yt-dlp stdout is empty', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '   ', stderr: '' });
        }
      );

      const result = await fetchYtDlpJson('https://www.youtube.com/watch?v=video123');

      expect(result).toBeNull();
    });

    it('should return null when yt-dlp throws an error', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          const error = new Error('yt-dlp failed') as any;
          error.stdout = '';
          error.stderr = 'error';
          callback(error, { stdout: '', stderr: 'error' });
        }
      );

      const result = await fetchYtDlpJson('https://www.youtube.com/watch?v=video123');

      expect(result).toBeNull();
    });

    it('should map YtDlpVideoInfo to VideoInfo', async () => {
      const url = 'https://www.youtube.com/watch?v=video123';
      const ytDlpJson = {
        id: 'video123',
        title: 'Test title',
        uploader: 'Uploader',
        uploader_id: 'uploader123',
        channel: 'Channel',
        channel_id: 'channel123',
        channel_url: 'https://example.com/channel',
        duration: 120,
        description: 'Description',
        upload_date: '20250101',
        webpage_url: 'https://example.com/watch?v=video123',
        view_count: 42,
        like_count: 5,
      };

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: JSON.stringify(ytDlpJson), stderr: '' });
        }
      );

      const info = await fetchVideoInfo(url);

      expect(info).toEqual({
        id: 'video123',
        title: 'Test title',
        uploader: 'Uploader',
        uploaderId: 'uploader123',
        channel: 'Channel',
        channelId: 'channel123',
        channelUrl: 'https://example.com/channel',
        duration: 120,
        description: 'Description',
        uploadDate: '20250101',
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
      });
    });

    it('should return null from fetchVideoInfo when yt-dlp returns empty output', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '   ', stderr: '' });
        }
      );

      const info = await fetchVideoInfo('https://www.youtube.com/watch?v=video123');

      expect(info).toBeNull();
    });
  });

  describe('searchVideos', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return parsed search results from yt-dlp', async () => {
      const searchJson = {
        entries: [
          {
            id: 'vid1',
            title: 'Video One',
            webpage_url: 'https://www.youtube.com/watch?v=vid1',
            duration: 120,
            uploader: 'Channel One',
            view_count: 1000,
            thumbnail: 'https://i.ytimg.com/vi/vid1/default.jpg',
          },
        ],
      };

      execFileMock.mockImplementation(
        (
          file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          expect(file).toBe('yt-dlp');
          expect(args).toContain('--flat-playlist');
          expect(args).toContain('--dump-single-json');
          expect(args.some((a) => a.startsWith('ytsearch'))).toBe(true);
          expect(args.some((a) => a.includes('test query'))).toBe(true);
          callback(null, { stdout: JSON.stringify(searchJson), stderr: '' });
        }
      );

      const result = await searchVideos('test query', 10);

      expect(result).toEqual([
        {
          videoId: 'vid1',
          title: 'Video One',
          url: 'https://www.youtube.com/watch?v=vid1',
          duration: 120,
          uploader: 'Channel One',
          viewCount: 1000,
          thumbnail: 'https://i.ytimg.com/vi/vid1/default.jpg',
        },
      ]);
    });

    it('should fall back to i.ytimg.com thumbnail when yt-dlp omits thumbnail', async () => {
      const searchJson = {
        entries: [
          {
            id: 'vid2',
            title: 'Video Two',
            webpage_url: 'https://www.youtube.com/watch?v=vid2',
            duration: 60,
            uploader: 'Channel Two',
            view_count: 500,
          },
        ],
      };

      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: JSON.stringify(searchJson), stderr: '' });
        }
      );

      const result = await searchVideos('query', 10);

      expect(result).toEqual([
        {
          videoId: 'vid2',
          title: 'Video Two',
          url: 'https://www.youtube.com/watch?v=vid2',
          duration: 60,
          uploader: 'Channel Two',
          viewCount: 500,
          thumbnail: 'https://i.ytimg.com/vi/vid2/hqdefault.jpg',
        },
      ]);
    });

    it('should return empty array when yt-dlp stdout is empty', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '   ', stderr: '' });
        }
      );

      const result = await searchVideos('query', 5);

      expect(result).toEqual([]);
    });

    it('should return null when yt-dlp throws an error', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          const error = new Error('yt-dlp failed') as any;
          error.stdout = '';
          error.stderr = 'error';
          callback(error, { stdout: '', stderr: 'error' });
        }
      );

      const result = await searchVideos('query', 10);

      expect(result).toBeNull();
    });

    it('should clamp limit to 1-50 range', async () => {
      execFileMock.mockImplementation(
        (
          file: string,
          args: string[],
          _opts: unknown,
          cb: (e: null, r: { stdout: string }) => void
        ) => {
          const ytsearchArg = args.find((a) => a.startsWith('ytsearch'));
          expect(ytsearchArg).toBe('ytsearch50:query'); // 100 clamped to 50
          cb(null, { stdout: JSON.stringify({ entries: [] }) });
        }
      );
      await searchVideos('query', 100);

      execFileMock.mockImplementation(
        (
          file: string,
          args: string[],
          _opts: unknown,
          cb: (e: null, r: { stdout: string }) => void
        ) => {
          const ytsearchArg = args.find((a) => a.startsWith('ytsearch'));
          expect(ytsearchArg).toBe('ytsearch1:query'); // 0 clamped to 1
          cb(null, { stdout: JSON.stringify({ entries: [] }) });
        }
      );
      await searchVideos('query', 0);
    });

    it('should pass dateBefore, date, matchFilter to yt-dlp when provided', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _opts: unknown,
          cb: (e: null, r: { stdout: string }) => void
        ) => {
          expect(args).toContain('--datebefore');
          expect(args[args.indexOf('--datebefore') + 1]).toBe('now-1year');
          expect(args).toContain('--date');
          expect(args[args.indexOf('--date') + 1]).toBe('20231215');
          expect(args).toContain('--match-filter');
          expect(args[args.indexOf('--match-filter') + 1]).toBe('!is_live');
          cb(null, { stdout: JSON.stringify({ entries: [] }) });
        }
      );
      await searchVideos('query', 10, undefined, {
        dateBefore: 'now-1year',
        date: '20231215',
        matchFilter: '!is_live',
      });
    });
  });

  describe('collectExecFileErrorDetails', () => {
    it('should include exitCode, cmd, and streams when present', () => {
      const err = new Error('Command failed: yt-dlp') as Error & {
        code?: number;
        cmd?: string;
        stdout?: string;
        stderr?: string;
      };
      err.code = 1;
      err.cmd = 'yt-dlp --help';
      err.stderr = 'boom';
      const d = collectExecFileErrorDetails(err);
      expect(d.message).toContain('Command failed');
      expect(d.exitCode).toBe(1);
      expect(d.cmd).toBe('yt-dlp --help');
      expect(d.stderr).toBe('boom');
    });
  });

  describe('classifyYtDlpFailure', () => {
    const cases: Array<[string, string]> = [
      ["ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies", 'bot_check'],
      ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'rate_limited'],
      ['ERROR: [youtube] x: Private video. Sign in if you have been granted access', 'private'],
      ['ERROR: [youtube] x: Sign in to confirm your age', 'age_restricted'],
      ['ERROR: The uploader has not made this video available in your country', 'geo_blocked'],
      ['WARNING: [youtube] nsig extraction failed: Some players may not work', 'extractor'],
      ['ERROR: [youtube] x: Video unavailable. This video has been removed', 'unavailable'],
      ['ERROR: something we have never seen', 'unknown'],
      [
        'WARNING: [TikTok] The extractor specified to use impersonation for this download, but no impersonate target is available.\nERROR: [TikTok] 123: Unexpected response from webpage request',
        'extractor',
      ],
      [
        'ERROR: [dailymotion] x5: The extractor is attempting impersonation, but none of these impersonate targets are available: firefox.',
        'extractor',
      ],
      ['ERROR: [youtube] x: Video is unavailable', 'unavailable'],
      [
        "ERROR: [youtube] x: Video unavailable. This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
        'rate_limited',
      ],
      ['ERROR: [TikTok] 123: Your IP address is blocked from accessing this post', 'geo_blocked'],
    ];

    it.each(cases)('should classify %s as %s', (stderr, expected) => {
      expect(classifyYtDlpFailure({ message: 'Command failed: yt-dlp', stderr })).toBe(expected);
    });

    it('should read a kill by our own timeout as a timeout', () => {
      expect(classifyYtDlpFailure({ message: 'Command failed', signal: 'SIGTERM' })).toBe(
        'timeout'
      );
    });

    it('should prefer the stderr cause over the timeout signal', () => {
      expect(
        classifyYtDlpFailure({
          message: 'Command failed',
          signal: 'SIGTERM',
          stderr: 'HTTP Error 429: Too Many Requests',
        })
      ).toBe('rate_limited');
    });

    it('should keep a removed video unavailable when the impersonation warning is also there', () => {
      expect(
        classifyYtDlpFailure({
          message: 'Command failed',
          stderr:
            'WARNING: [youtube] x: no impersonate target is available\nERROR: [youtube] x: Video unavailable. This video has been removed',
        })
      ).toBe('unavailable');
    });

    it('should classify a bot check before an age check when both appear', () => {
      expect(
        classifyYtDlpFailure({
          message: 'Command failed',
          stderr: "Sign in to confirm you're not a bot; age-restricted",
        })
      ).toBe('bot_check');
    });
  });

  describe('yt-dlp failures that are about the server, not the video', () => {
    const botCheck = "ERROR: [youtube] x: Sign in to confirm you're not a bot";

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should reject fetchYtDlpJson with a classified error on a bot check', async () => {
      mockExecFileFailure(botCheck);
      await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=abc')).rejects.toMatchObject({
        name: 'YtDlpError',
        reason: 'bot_check',
        statusCode: 502,
      });
    });

    it('should reject fetchYtDlpJson with the per-video reason for a private video', async () => {
      mockExecFileFailure('ERROR: [youtube] x: Private video');
      await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=abc')).rejects.toMatchObject({
        name: 'YtDlpError',
        reason: 'private',
        statusCode: 404,
      });
    });

    it('should keep returning null from fetchYtDlpJson when the reason is unknown', async () => {
      mockExecFileFailure('ERROR: something we have never seen');
      await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=abc')).resolves.toBeNull();
    });

    it('should reject a frame capture of a private video after one yt-dlp run', async () => {
      mockExecFileFailure('ERROR: [youtube] x: Private video');
      await expect(
        captureVideoFrame('https://www.youtube.com/watch?v=abc', 10)
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'private' });
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('should reject a refusal that yt-dlp reports as a warning with exit code 0', async () => {
      // --ignore-no-formats-error: exit 0, a JSON stub without formats, the reason in stderr.
      const cases: Array<[string, string]> = [
        ['WARNING: [youtube] Private video\nWARNING: No video formats found!', 'private'],
        [
          'WARNING: [youtube] This video is unavailable\nWARNING: Requested format is not available',
          'unavailable',
        ],
      ];
      for (const [stderr, reason] of cases) {
        execFileMock.mockImplementation(
          (
            _file: string,
            _args: string[],
            _options: unknown,
            callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
          ) => {
            callback(null, {
              stdout: JSON.stringify({ id: 'x', title: 'youtube video #x', formats: [] }),
              stderr,
            });
          }
        );
        await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=x')).rejects.toMatchObject({
          name: 'YtDlpError',
          reason,
        });
      }
    });

    it('should keep a video whose formats failed but whose subtitle tracks are listed', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, {
            stdout: JSON.stringify({
              id: 'x',
              title: 'Real title',
              formats: [],
              automatic_captions: { en: [{ ext: 'vtt' }] },
            }),
            stderr:
              'WARNING: [youtube] x: nsig extraction failed\nWARNING: No video formats found!',
          });
        }
      );
      await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=x')).resolves.toMatchObject({
        title: 'Real title',
      });
    });

    it('should keep the metadata of an age-restricted video that yt-dlp still described', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, {
            stdout: JSON.stringify({ id: 'x', title: 'Real title', formats: [] }),
            stderr:
              'WARNING: [youtube] x: Sign in to confirm your age\nWARNING: No video formats found!',
          });
        }
      );
      await expect(fetchYtDlpJson('https://www.youtube.com/watch?v=x')).resolves.toMatchObject({
        title: 'Real title',
      });
    });

    it('should reject downloadSubtitles with a classified error on rate limiting', async () => {
      mockExecFileFailure('ERROR: HTTP Error 429: Too Many Requests');
      await expect(
        downloadSubtitles('https://www.youtube.com/watch?v=abc', 'auto', 'en')
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
    });

    it('should never put the command line or stderr in the error message', async () => {
      mockExecFileFailure(botCheck);
      await expect(
        downloadSubtitles('https://www.youtube.com/watch?v=abc', 'auto', 'en')
      ).rejects.toThrow(/^(?!.*(Command failed|cookies|ERROR:)).*$/s);
    });
  });

  describe('child-process concurrency limiter', () => {
    const url = 'https://www.youtube.com/watch?v=limit123';
    let releases: Array<() => void>;

    /** Lets every pending promise advance to its next await. */
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      jest.clearAllMocks();
      releases = [];
      process.env.YT_DLP_MAX_CONCURRENCY = '2';
      process.env.YT_DLP_MAX_QUEUE = '1';
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          releases.push(() => callback(null, { stdout: '{"id":"limit123"}', stderr: '' }));
        }
      );
    });

    afterEach(async () => {
      // Hand every slot back, or the rest of the file would queue behind this test.
      while (releases.length > 0) {
        releases.shift()?.();
        await tick();
      }
      delete process.env.YT_DLP_MAX_CONCURRENCY;
      delete process.env.YT_DLP_MAX_QUEUE;
    });

    it('should run up to the cap, queue the next, and refuse beyond the queue', async () => {
      const started: Array<Promise<unknown>> = [];
      for (let i = 0; i < 4; i += 1) {
        started.push(fetchYtDlpJson(url).catch((err: unknown) => err));
        await tick();
      }

      expect(execFileMock).toHaveBeenCalledTimes(2);
      await expect(started[3]).resolves.toMatchObject({
        name: 'ServerBusyError',
        statusCode: 503,
      });

      releases.shift()?.();
      await tick();
      expect(execFileMock).toHaveBeenCalledTimes(3);

      while (releases.length > 0) {
        releases.shift()?.();
        await tick();
      }
      await Promise.all(started.slice(0, 3));

      const metrics = await renderPrometheus();
      expect(metrics).toMatch(/^yt_dlp_processes_active\{[^}]*\} 0$/m);
      expect(metrics).toMatch(/^yt_dlp_queue_length\{[^}]*\} 0$/m);
    });

    it('should not limit anything when YT_DLP_MAX_CONCURRENCY is 0', async () => {
      process.env.YT_DLP_MAX_CONCURRENCY = '0';

      const started: Array<Promise<unknown>> = [];
      for (let i = 0; i < 5; i += 1) {
        started.push(fetchYtDlpJson(url));
        await tick();
      }

      expect(execFileMock).toHaveBeenCalledTimes(5);
      while (releases.length > 0) {
        releases.shift()?.();
        await tick();
      }
      await Promise.all(started);
    });
  });

  describe('downloadPlaylistSubtitles', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.YT_DLP_PLAYLIST_IGNORE_ERRORS;
    });

    it('should pass --yes-playlist, --playlist-items, --max-downloads, --ignore-errors to yt-dlp', async () => {
      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _opts: unknown,
          cb: (err: null, stdout: string, stderr: string) => void
        ) => {
          capturedArgs = args;
          setImmediate(() => cb(null, '', ''));
        }
      );
      const results = await downloadPlaylistSubtitles(
        'https://www.youtube.com/playlist?list=PLxxx',
        {
          playlistItems: '1:5',
          maxItems: 3,
          type: 'official',
          lang: 'en',
        }
      );
      expect(results).toEqual([]);
      expect(execFileMock).toHaveBeenCalled();
      expect(capturedArgs).toContain('--yes-playlist');
      expect(capturedArgs).toContain('--ignore-errors');
      expect(capturedArgs).toContain('--playlist-items');
      expect(capturedArgs[capturedArgs.indexOf('--playlist-items') + 1]).toBe('1:5');
      expect(capturedArgs).toContain('--max-downloads');
      expect(capturedArgs[capturedArgs.indexOf('--max-downloads') + 1]).toBe('3');
      expect(capturedArgs).toContain('--write-subs');
    });

    it('should omit --ignore-errors when YT_DLP_PLAYLIST_IGNORE_ERRORS=0', async () => {
      process.env.YT_DLP_PLAYLIST_IGNORE_ERRORS = '0';
      let capturedArgs: string[] = [];
      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _opts: unknown,
          cb: (err: null, stdout: string, stderr: string) => void
        ) => {
          capturedArgs = args;
          setImmediate(() => cb(null, '', ''));
        }
      );
      await downloadPlaylistSubtitles('https://www.youtube.com/playlist?list=PLxxx', {});
      expect(capturedArgs).not.toContain('--ignore-errors');
    });

    it('should reject with the classified failure when yt-dlp exits with error', async () => {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error('Command failed: yt-dlp') as Error & {
            code?: number;
            stderr?: string;
          };
          err.code = 1;
          err.stderr = 'private video';
          setImmediate(() => cb(err, '', ''));
        }
      );
      await expect(
        downloadPlaylistSubtitles('https://www.youtube.com/playlist?list=PLxxx', {})
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'private' });
    });

    it('reports a cancelled queue that produced nothing and hit a limit as that limit', async () => {
      mockExecFileFailure(
        'ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests',
        101
      );

      await expect(
        downloadPlaylistSubtitles('https://www.youtube.com/playlist?list=PLxxx', { maxItems: 2 })
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
    });

    it('does not run while the platform is holding subtitle downloads back', async () => {
      noteSubtitlesRateLimited('https://www.youtube.com/watch?v=x');

      await expect(
        downloadPlaylistSubtitles('https://www.youtube.com/playlist?list=PLxxx', { maxItems: 2 })
      ).rejects.toMatchObject({ name: 'YtDlpError', reason: 'rate_limited' });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('treats exit 101 as the end of a bounded run, not as a failure', async () => {
      // `--max-downloads` reached: yt-dlp cancels the queue on purpose and says so on
      // stdout, which `--quiet` swallows — so the call used to fail with `unknown`.
      mockExecFileFailure('', 101);

      await expect(
        downloadPlaylistSubtitles('https://www.youtube.com/playlist?list=PLxxx', { maxItems: 2 })
      ).resolves.toEqual([]);
    });
  });

  describe('captureVideoFrame', () => {
    const url = 'https://www.youtube.com/watch?v=frame123';
    type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.COOKIES_FILE_PATH;
      delete process.env.YT_DLP_PROXY;
      delete process.env.YT_DLP_TIMEOUT;
      delete process.env.YT_DLP_FRAME_TIMEOUT;
    });

    it('should capture frame via direct stream URL with -ss seek', async () => {
      const timestamp = 1700000001000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const outputPath = join(tmpdir(), `${urlToSafeBase(url, 'frame')}.jpg`);
      const frameBytes = Buffer.from('fake-jpeg-bytes');
      const ffmpegCalls: string[][] = [];

      execFileMock.mockImplementation(
        (file: string, args: string[], _options: unknown, callback: ExecCallback) => {
          if (file === 'yt-dlp') {
            callback(null, {
              stdout: 'vid123\n212.5\nhttps://cdn.example/stream.mp4\n',
              stderr: '',
            });
            return;
          }
          ffmpegCalls.push(args);
          void writeFile(outputPath, frameBytes).then(() =>
            callback(null, { stdout: '', stderr: '' })
          );
        }
      );

      const outcome = await captureVideoFrame(url, 83.5, {
        format: 'jpeg',
        width: 1280,
        quality: 4,
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.videoId).toBe('vid123');
        expect(outcome.mimeType).toBe('image/jpeg');
        expect(outcome.data.equals(frameBytes)).toBe(true);
      }
      expect(ffmpegCalls).toHaveLength(1);
      const args = ffmpegCalls[0];
      expect(args[args.indexOf('-ss') + 1]).toBe('83.5');
      expect(args[args.indexOf('-i') + 1]).toBe('https://cdn.example/stream.mp4');
      expect(args[args.indexOf('-q:v') + 1]).toBe('4');
      expect(args).toContain('scale=min(iw\\,1280):-2');
      // output file is consumed and removed
      await expect(access(outputPath, constants.F_OK)).rejects.toThrow();
      dateSpy.mockRestore();
    });

    it('should return timestamp_beyond_duration without running ffmpeg', async () => {
      execFileMock.mockImplementation(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, {
            stdout: 'vid123\n100\nhttps://cdn.example/stream.mp4\n',
            stderr: '',
          });
        }
      );

      const outcome = await captureVideoFrame(url, 500);

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'timestamp_beyond_duration',
        videoId: 'vid123',
        durationSeconds: 100,
      });
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('should fall back to section download when direct capture fails', async () => {
      const timestamp = 1700000002000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(timestamp);
      const outputPath = join(tmpdir(), `${urlToSafeBase(url, 'frame')}.png`);
      const clipPath = join(tmpdir(), `${urlToSafeBase(url, 'frame_clip')}.mp4`);
      const frameBytes = Buffer.from('fake-png-bytes');
      let ffmpegCallCount = 0;
      let sectionArgs: string[] = [];

      execFileMock.mockImplementation(
        (file: string, args: string[], _options: unknown, callback: ExecCallback) => {
          if (file === 'yt-dlp') {
            if (args.includes('--download-sections')) {
              sectionArgs = args;
              void writeFile(clipPath, 'fake clip').then(() =>
                callback(null, { stdout: '', stderr: '' })
              );
              return;
            }
            callback(null, {
              stdout: 'vid123\n212\nhttps://cdn.example/stream.mp4\n',
              stderr: '',
            });
            return;
          }
          ffmpegCallCount += 1;
          if (ffmpegCallCount === 1) {
            callback(new Error('ffmpeg: connection refused'));
            return;
          }
          void writeFile(outputPath, frameBytes).then(() =>
            callback(null, { stdout: '', stderr: '' })
          );
        }
      );

      const outcome = await captureVideoFrame(url, 10, { format: 'png' });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.mimeType).toBe('image/png');
        expect(outcome.data.equals(frameBytes)).toBe(true);
      }
      expect(sectionArgs).toContain('--force-keyframes-at-cuts');
      expect(sectionArgs[sectionArgs.indexOf('--download-sections') + 1]).toBe('*10-12');
      // clip is cleaned up
      await expect(access(clipPath, constants.F_OK)).rejects.toThrow();
      dateSpy.mockRestore();
    });

    it('should return capture_failed when all attempts fail', async () => {
      execFileMock.mockImplementation(
        (file: string, args: string[], _options: unknown, callback: ExecCallback) => {
          if (file === 'yt-dlp' && !args.includes('--download-sections')) {
            callback(null, {
              stdout: 'vid123\nNA\nhttps://cdn.example/stream.mp4\n',
              stderr: '',
            });
            return;
          }
          callback(Object.assign(new Error('boom'), { code: 1 }));
        }
      );

      const outcome = await captureVideoFrame(url, 10);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.reason === 'capture_failed') {
        expect(outcome.videoId).toBe('vid123');
        expect(outcome.details.message).toContain('boom');
      } else {
        throw new Error(`Expected capture_failed outcome, got ${JSON.stringify(outcome)}`);
      }
    });
  });

  describe('getImageWidth', () => {
    function makePngHeader(width: number, height: number): Buffer {
      const buf = Buffer.alloc(24);
      buf.writeUInt32BE(0x89504e47, 0);
      buf.writeUInt32BE(0x0d0a1a0a, 4);
      buf.writeUInt32BE(13, 8);
      buf.write('IHDR', 12, 'ascii');
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    }

    function makeJpegHeader(width: number, height: number): Buffer {
      const soi = Buffer.from([0xff, 0xd8]);
      // Minimal APP0 segment (length 4 = length bytes + 2 payload bytes)
      const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
      const sof = Buffer.alloc(9);
      sof[0] = 0xff;
      sof[1] = 0xc0;
      sof.writeUInt16BE(0x0011, 2);
      sof[4] = 8;
      sof.writeUInt16BE(height, 5);
      sof.writeUInt16BE(width, 7);
      return Buffer.concat([soi, app0, sof]);
    }

    it('should read width from PNG IHDR', () => {
      expect(getImageWidth(makePngHeader(1280, 720))).toBe(1280);
      expect(getImageWidth(makePngHeader(640, 360))).toBe(640);
    });

    it('should read width from JPEG SOF0 after skipping other segments', () => {
      expect(getImageWidth(makeJpegHeader(1920, 1080))).toBe(1920);
    });

    it('should return null for unrecognized data', () => {
      expect(getImageWidth(Buffer.from('not an image at all, padding'))).toBeNull();
      expect(getImageWidth(Buffer.alloc(0))).toBeNull();
    });
  });
});
