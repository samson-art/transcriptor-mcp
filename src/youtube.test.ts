import { execFile } from 'node:child_process';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { access, constants, writeFile, unlink } from 'node:fs/promises';
import * as youtube from './youtube.js';

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
  formatPlaylistDownloadFailureMessage,
} = youtube;

describe('youtube', () => {
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

  describe('formatPlaylistDownloadFailureMessage', () => {
    it('should include exit code and stderr tail', () => {
      const msg = formatPlaylistDownloadFailureMessage({
        message: 'Command failed: yt-dlp',
        exitCode: 1,
        stderr: 'Sign in to confirm',
      });
      expect(msg).toContain('Command failed');
      expect(msg).toContain('exit code: 1');
      expect(msg).toContain('Sign in to confirm');
      expect(msg).toContain('YT_DLP_VERBOSE_ON_ERROR');
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
      const outcome = await downloadPlaylistSubtitles(
        'https://www.youtube.com/playlist?list=PLxxx',
        {
          playlistItems: '1:5',
          maxItems: 3,
          type: 'official',
          lang: 'en',
        }
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.results).toEqual([]);
      }
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
      const outcome = await downloadPlaylistSubtitles(
        'https://www.youtube.com/playlist?list=PLxxx',
        {}
      );
      expect(outcome.ok).toBe(true);
      expect(capturedArgs).not.toContain('--ignore-errors');
    });

    it('should return ok:false with failure details when yt-dlp exits with error', async () => {
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
      const outcome = await downloadPlaylistSubtitles(
        'https://www.youtube.com/playlist?list=PLxxx',
        {}
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure.message).toContain('Command failed');
        expect(outcome.failure.exitCode).toBe(1);
        expect(outcome.failure.stderr).toBe('private video');
      }
    });
  });
});
