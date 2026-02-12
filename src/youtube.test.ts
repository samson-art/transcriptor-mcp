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
  extractVideoId,
  detectSubtitleFormat,
  parseSubtitles,
  downloadSubtitles,
  fetchVideoInfo,
  fetchYtDlpJson,
  findSubtitleFile,
  getYtDlpEnv,
  appendYtDlpEnvArgs,
  urlToSafeBase,
} = youtube;

describe('youtube', () => {
  describe('extractVideoId', () => {
    it('should extract video ID from standard YouTube URLs', () => {
      expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should extract video ID from URLs with additional parameters', () => {
      expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe(
        'dQw4w9WgXcQ'
      );
      expect(extractVideoId('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ'
      );
    });

    it('should return null for invalid URLs', () => {
      expect(extractVideoId('not-a-url')).toBeNull();
      expect(extractVideoId('https://example.com')).toBeNull();
      expect(extractVideoId('')).toBeNull();
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

    it('should default to SRT for content without WEBVTT header', () => {
      expect(detectSubtitleFormat('Some text')).toBe('srt');
      expect(detectSubtitleFormat('')).toBe('srt');
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
    });

    it('should read and trim environment variables for yt-dlp', () => {
      process.env.YT_DLP_JS_RUNTIMES = ' node ';
      process.env.YT_DLP_REMOTE_COMPONENTS = ' custom ';
      process.env.COOKIES_FILE_PATH = ' /path/to/cookies.txt ';

      const env = getYtDlpEnv();

      expect(env).toEqual({
        jsRuntimes: 'node',
        remoteComponents: 'custom',
        cookiesFilePathFromEnv: '/path/to/cookies.txt',
      });
    });

    it('should provide default remoteComponents when not set', () => {
      const env = getYtDlpEnv();

      expect(env.remoteComponents).toBe('ejs:github');
    });

    it('should insert yt-dlp flags before the URL argument', () => {
      const args = ['--dump-single-json', '--skip-download', 'https://example.com'];

      const env = {
        jsRuntimes: 'node',
        remoteComponents: 'ejs:github',
        cookiesFilePathFromEnv: '/cookies.txt',
      };

      appendYtDlpEnvArgs(args, env);

      expect(args).toEqual([
        '--dump-single-json',
        '--skip-download',
        '--cookies',
        '/cookies.txt',
        '--js-runtimes',
        'node',
        '--remote-components',
        'ejs:github',
        'https://example.com',
      ]);
    });
  });

  describe('fetchYtDlpJson and fetchVideoInfo', () => {
    beforeEach(() => {
      jest.clearAllMocks();
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
});
