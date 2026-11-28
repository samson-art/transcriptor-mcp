import {
  clearInflightJobsForTests,
  getPendingWhisperJobCount,
  getWhisperBackgroundTimeoutMs,
  startOrReuseWhisperJob,
} from './whisper-jobs.js';
import { ServerBusyError } from './errors.js';

jest.mock('./metrics.js', () => ({
  setWhisperBackgroundJobsActive: jest.fn(),
}));

jest.mock('./whisper.js', () => ({
  getWhisperConfig: jest.fn(() => ({
    mode: 'local' as const,
    timeout: 60_000,
    baseUrl: 'http://whisper:9000',
    apiBaseUrl: 'https://api.openai.com/v1',
  })),
  transcribeWithWhisper: jest.fn(),
}));

const whisperMock = jest.requireMock<{
  getWhisperConfig: jest.Mock;
  transcribeWithWhisper: jest.Mock;
}>('./whisper.js');

const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  clearInflightJobsForTests();
  process.env = { ...originalEnv };
  delete process.env.WHISPER_BACKGROUND_TIMEOUT;
  delete process.env.WHISPER_MAX_CONCURRENCY;
  whisperMock.getWhisperConfig.mockReturnValue({
    mode: 'local',
    timeout: 60_000,
    baseUrl: 'http://whisper:9000',
    apiBaseUrl: 'https://api.openai.com/v1',
  });
});

afterAll(() => {
  process.env = originalEnv;
  clearInflightJobsForTests();
});

describe('getWhisperBackgroundTimeoutMs', () => {
  it('returns 0 when WHISPER_BACKGROUND_TIMEOUT=0', () => {
    process.env.WHISPER_BACKGROUND_TIMEOUT = '0';
    expect(getWhisperBackgroundTimeoutMs()).toBe(0);
  });

  it('returns parsed ms when WHISPER_BACKGROUND_TIMEOUT is set', () => {
    process.env.WHISPER_BACKGROUND_TIMEOUT = '900000';
    expect(getWhisperBackgroundTimeoutMs()).toBe(900_000);
  });

  it('defaults to max(30 minutes, 3 * WHISPER_TIMEOUT) when unset', () => {
    whisperMock.getWhisperConfig.mockReturnValue({
      mode: 'local',
      timeout: 120_000,
      baseUrl: 'http://whisper:9000',
      apiBaseUrl: 'https://api.openai.com/v1',
    });
    expect(getWhisperBackgroundTimeoutMs()).toBe(Math.max(1_800_000, 360_000));
  });
});

describe('startOrReuseWhisperJob', () => {
  it('deduplicates concurrent jobs for same url, lang, and format', async () => {
    whisperMock.transcribeWithWhisper.mockResolvedValue('transcript');
    const url = 'https://www.youtube.com/watch?v=abc';
    const p1 = startOrReuseWhisperJob(url, 'en', 'srt');
    const p2 = startOrReuseWhisperJob(url, 'en', 'srt');
    expect(whisperMock.transcribeWithWhisper).toHaveBeenCalledTimes(1);
    await expect(Promise.all([p1, p2])).resolves.toEqual(['transcript', 'transcript']);
    expect(getPendingWhisperJobCount()).toBe(0);
  });

  it('starts separate jobs for different formats', async () => {
    whisperMock.transcribeWithWhisper.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const url = 'https://example.com/v';
    await expect(startOrReuseWhisperJob(url, 'en', 'srt')).resolves.toBe('a');
    await expect(startOrReuseWhisperJob(url, 'en', 'vtt')).resolves.toBe('b');
    expect(whisperMock.transcribeWithWhisper).toHaveBeenCalledTimes(2);
  });

  it('passes background timeout from getWhisperBackgroundTimeoutMs to transcribeWithWhisper', async () => {
    process.env.WHISPER_BACKGROUND_TIMEOUT = '222000';
    whisperMock.transcribeWithWhisper.mockResolvedValue('ok');
    await startOrReuseWhisperJob('https://example.com/v', '', 'srt');
    expect(whisperMock.transcribeWithWhisper).toHaveBeenCalledWith(
      'https://example.com/v',
      '',
      'srt',
      undefined,
      222_000
    );
  });

  // Each job holds its audio in memory, and in API mode it costs money (#132).
  describe('WHISPER_MAX_CONCURRENCY', () => {
    const pending = () => new Promise<string | null>(() => {});

    it('refuses a third distinct job at once with server busy when 2 run (the default)', () => {
      whisperMock.transcribeWithWhisper.mockImplementation(pending);
      void startOrReuseWhisperJob('https://example.com/a', 'en', 'srt');
      void startOrReuseWhisperJob('https://example.com/b', 'en', 'srt');

      expect(() => startOrReuseWhisperJob('https://example.com/c', 'en', 'srt')).toThrow(
        ServerBusyError
      );
      expect(whisperMock.transcribeWithWhisper).toHaveBeenCalledTimes(2);
    });

    it('still lets a call join a job that runs while the limit is full', () => {
      whisperMock.transcribeWithWhisper.mockImplementation(pending);
      const first = startOrReuseWhisperJob('https://example.com/a', 'en', 'srt');
      void startOrReuseWhisperJob('https://example.com/b', 'en', 'srt');

      expect(startOrReuseWhisperJob('https://example.com/a', 'en', 'srt')).toBe(first);
    });

    it('starts a new job after one of the running jobs ends', async () => {
      process.env.WHISPER_MAX_CONCURRENCY = '1';
      whisperMock.transcribeWithWhisper.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
      await startOrReuseWhisperJob('https://example.com/a', 'en', 'srt');

      await expect(startOrReuseWhisperJob('https://example.com/b', 'en', 'srt')).resolves.toBe('b');
    });

    it('sets no limit with 0', () => {
      process.env.WHISPER_MAX_CONCURRENCY = '0';
      whisperMock.transcribeWithWhisper.mockImplementation(pending);
      for (const id of ['a', 'b', 'c', 'd']) {
        void startOrReuseWhisperJob(`https://example.com/${id}`, 'en', 'srt');
      }
      expect(getPendingWhisperJobCount()).toBe(4);
    });
  });
});
