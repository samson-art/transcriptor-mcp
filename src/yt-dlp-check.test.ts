import { execFile } from 'node:child_process';
import {
  parseYtDlpVersion,
  compareYtDlpVersions,
  fetchLatestYtDlpVersion,
  checkYtDlpAtStartup,
} from './yt-dlp-check.js';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

const originalEnv = process.env;
const originalExit = process.exit;

describe('yt-dlp-check', () => {
  describe('parseYtDlpVersion', () => {
    it('parses YYYY.MM.DD format', () => {
      expect(parseYtDlpVersion('2026.02.04')).toEqual([2026, 2, 4]);
    });

    it('parses YYYY.M.D format', () => {
      expect(parseYtDlpVersion('2026.2.4')).toEqual([2026, 2, 4]);
    });

    it('returns null for invalid strings', () => {
      expect(parseYtDlpVersion('')).toBeNull();
      expect(parseYtDlpVersion('abc')).toBeNull();
      expect(parseYtDlpVersion('1.2')).toBeNull();
    });

    it('uses first three numeric segments only', () => {
      expect(parseYtDlpVersion('2026.02.04.5')).toEqual([2026, 2, 4]);
    });
  });

  describe('compareYtDlpVersions', () => {
    it('returns -1 when a < b', () => {
      expect(compareYtDlpVersions([2026, 1, 1], [2026, 2, 4])).toBe(-1);
      expect(compareYtDlpVersions([2025, 12, 31], [2026, 1, 1])).toBe(-1);
    });

    it('returns 0 when equal', () => {
      expect(compareYtDlpVersions([2026, 2, 4], [2026, 2, 4])).toBe(0);
    });

    it('returns 1 when a > b', () => {
      expect(compareYtDlpVersions([2026, 2, 4], [2026, 1, 1])).toBe(1);
      expect(compareYtDlpVersions([2027, 1, 1], [2026, 12, 31])).toBe(1);
    });
  });

  describe('fetchLatestYtDlpVersion', () => {
    it('returns tag_name from GitHub API response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: '2026.02.04' }),
      });
      global.fetch = mockFetch;

      const result = await fetchLatestYtDlpVersion();
      expect(result).toBe('2026.02.04');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('transcriptor-mcp'),
          }),
        })
      );
    });

    it('returns null when response is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false });
      expect(await fetchLatestYtDlpVersion()).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
      expect(await fetchLatestYtDlpVersion()).toBeNull();
    });
  });

  describe('checkYtDlpAtStartup', () => {
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env = { ...originalEnv };
      execFileMock.mockReset();
      if (exitSpy) exitSpy.mockClear();
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    });

    afterAll(() => {
      process.env = originalEnv;
      process.exit = originalExit;
    });

    it('logs ERROR and exits when yt-dlp is not found (ENOENT)', async () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      execFileMock.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, s?: string) => void) => {
          cb(err);
        }
      );

      const log = { error: jest.fn(), warn: jest.fn() };

      await checkYtDlpAtStartup(log);

      expect(log.error).toHaveBeenCalledWith(
        'yt-dlp not found in system (not in PATH or not installed)'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs ERROR but does not exit when yt-dlp not found and YT_DLP_REQUIRED=0', async () => {
      process.env.YT_DLP_REQUIRED = '0';
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      execFileMock.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, s?: string) => void) => {
          cb(err);
        }
      );

      const log = { error: jest.fn(), warn: jest.fn() };

      await checkYtDlpAtStartup(log);

      expect(log.error).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('logs ERROR and exits on generic exec error (non-ENOENT)', async () => {
      const err = new Error('spawn failed');
      execFileMock.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, s?: string) => void) => {
          cb(err);
        }
      );

      const log = { error: jest.fn(), warn: jest.fn() };

      await checkYtDlpAtStartup(log);

      expect(log.error).toHaveBeenCalledWith('yt-dlp failed to run or returned an error');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs WARNING when installed version is older than latest', async () => {
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          e: null,
          result: { stdout: string; stderr: string }
        ) => void;
        setImmediate(() => cb(null, { stdout: '2026.1.1', stderr: '' }));
      });

      const log = { error: jest.fn(), warn: jest.fn() };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: '2026.02.04' }),
      });

      await checkYtDlpAtStartup(log);

      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'yt-dlp version 2026.1.1 is older than latest 2026.02.04; consider upgrading'
      );
    });

    it('does not log WARNING when installed version equals latest', async () => {
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          e: null,
          result: { stdout: string; stderr: string }
        ) => void;
        setImmediate(() => cb(null, { stdout: '2026.02.04', stderr: '' }));
      });

      const log = { error: jest.fn(), warn: jest.fn() };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: '2026.02.04' }),
      });

      await checkYtDlpAtStartup(log);

      expect(log.warn).not.toHaveBeenCalled();
    });

    it('does not log WARNING when GitHub fetch fails', async () => {
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          e: null,
          result: { stdout: string; stderr: string }
        ) => void;
        setImmediate(() => cb(null, { stdout: '2026.1.1', stderr: '' }));
      });
      global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

      const log = { error: jest.fn(), warn: jest.fn() };

      await checkYtDlpAtStartup(log);

      expect(log.warn).not.toHaveBeenCalled();
    });

    it('skips version check when YT_DLP_SKIP_VERSION_CHECK=1', async () => {
      process.env.YT_DLP_SKIP_VERSION_CHECK = '1';
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          e: null,
          result: { stdout: string; stderr: string }
        ) => void;
        setImmediate(() => cb(null, { stdout: '2020.1.1', stderr: '' }));
      });
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      const log = { error: jest.fn(), warn: jest.fn() };
      await checkYtDlpAtStartup(log);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
