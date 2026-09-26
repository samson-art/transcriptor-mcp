import * as Sentry from '@sentry/node';

import { ServerBusyError, YtDlpError } from './errors.js';
import { runCanary, startCanary, resetCanaryForTests } from './canary.js';
import { renderPrometheus } from './metrics.js';
import {
  clearSubtitlesRateLimit,
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';
import * as validation from './validation.js';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

jest.mock('./validation.js', () => ({
  normalizeVideoInput:
    jest.requireActual<typeof import('./validation.js')>('./validation.js').normalizeVideoInput,
  validateAndDownloadSubtitles: jest.fn(),
}));

const CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const captureMessageMock = Sentry.captureMessage as unknown as jest.Mock;
const validateAndDownloadSubtitlesMock = validation.validateAndDownloadSubtitles as jest.Mock;

function createLogger() {
  return { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

/** The two ways a failure streak ends: a good probe, or a stand-down for a real track. */
const RECOVERIES = [
  [
    'a good probe',
    'probe',
    () => validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' }),
  ],
  ['real traffic', 'traffic', () => clearSubtitlesRateLimit(CANARY_URL)],
] as const;

describe('canary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCanaryForTests();
    resetSubtitleRateLimitsForTests();
    delete process.env.CANARY_INTERVAL_MS;
    delete process.env.CANARY_URL;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('runCanary', () => {
    it('does not probe when a real call just came back from the platform', async () => {
      // The probe exists to prove the caption path works. A transcript that came back
      // proves it for free, and the probe's own request is metered by the platform.
      clearSubtitlesRateLimit(CANARY_URL);

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
      expect(await renderPrometheus()).toMatch(/transcriptor_canary_ok\{[^}]*\} 1/);
    });

    it('stands down for a real call when CANARY_URL is a bare video id', async () => {
      process.env.CANARY_URL = 'jNQXAC9IVRw';
      clearSubtitlesRateLimit(CANARY_URL);

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
    });

    it('does not stand down after a 429 until a track comes back', async () => {
      // A track from before the 429 proves nothing, during the hold or after it. During the
      // hold the probe stops at the hold, with no request.
      jest.useFakeTimers();
      const logger = createLogger();
      validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
      await runCanary(logger as any);
      await runCanary(logger as any);
      captureMessageMock.mockClear();
      clearSubtitlesRateLimit(CANARY_URL);
      noteSubtitlesRateLimited(CANARY_URL);

      await runCanary(logger as any);
      // Past the 10-minute hold, inside the 15-minute interval.
      jest.advanceTimersByTime(11 * 60 * 1000);
      await runCanary(logger as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(4);
      expect(captureMessageMock).not.toHaveBeenCalled();
      expect(await renderPrometheus()).toMatch(/^transcriptor_canary_ok\{[^}]*\} 0$/m);
    });

    it('probes again once nothing has answered for a whole interval', async () => {
      jest.useFakeTimers();
      process.env.CANARY_INTERVAL_MS = '1';
      clearSubtitlesRateLimit(CANARY_URL);
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });

      jest.advanceTimersByTime(1);
      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalled();
    });

    it('probes CANARY_URL with one explicit language and skips the cache', async () => {
      process.env.CANARY_URL = 'https://www.youtube.com/watch?v=other123';
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://www.youtube.com/watch?v=other123',
          type: 'official',
          lang: 'en',
        }),
        expect.anything(),
        { skipCache: true }
      );
    });

    it('reports once per failure streak, not once per failure', async () => {
      const logger = createLogger();
      validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('bot_check'));

      await runCanary(logger as any);
      expect(captureMessageMock).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();

      await runCanary(logger as any);
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock).toHaveBeenCalledWith(
        'canary: transcript path failing',
        expect.objectContaining({ level: 'error', tags: { reason: 'bot_check', canary: 'true' } })
      );

      await runCanary(logger as any);
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
    });

    it.each(RECOVERIES)(
      'reports the recovery once when %s ends a failure streak',
      async (_by, via, recover) => {
        // With the path failing, the first sign of life is often a user's call, not a probe:
        // the stand-down it causes must end the streak the way a good probe would.
        const logger = createLogger();
        validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
        await runCanary(logger as any);
        await runCanary(logger as any);
        captureMessageMock.mockClear();

        recover();
        await runCanary(logger as any);
        await runCanary(logger as any);

        expect(captureMessageMock).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith('canary: transcript path recovered', {
          level: 'info',
          tags: { via },
        });
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ via }),
          'canary: transcript path recovered'
        );
        const metrics = await renderPrometheus();
        expect(metrics).toMatch(/^transcriptor_canary_ok\{[^}]*\} 1$/m);
        expect(metrics).toMatch(
          /^transcriptor_canary_last_success_timestamp_seconds\{[^}]*\} \d+/m
        );

        // The next failure starts a new streak, so it alone raises nothing.
        resetSubtitleRateLimitsForTests();
        validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
        await runCanary(logger as any);
        expect(captureMessageMock).toHaveBeenCalledTimes(1);
      }
    );

    it.each(RECOVERIES)(
      'starts a new streak when %s ends a single failure',
      async (_by, _via, recover) => {
        const logger = createLogger();
        validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
        await runCanary(logger as any);

        recover();
        await runCanary(logger as any);
        // The traffic stops, so the next tick probes.
        resetSubtitleRateLimitsForTests();
        validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
        await runCanary(logger as any);

        expect(captureMessageMock).not.toHaveBeenCalled();
      }
    );

    it('does not count a busy server against the transcript path', async () => {
      const logger = createLogger();
      validateAndDownloadSubtitlesMock.mockRejectedValue(new ServerBusyError());

      await runCanary(logger as any);
      await runCanary(logger as any);

      expect(captureMessageMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('canary: skipped, server busy');
    });
  });

  describe('startCanary', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      // Like the real path: the track arrives after a run, and stamps the platform as answered.
      validateAndDownloadSubtitlesMock.mockImplementation(async ({ url }) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        clearSubtitlesRateLimit(url);
        return { subtitlesContent: 'hello' };
      });
    });

    it('probes once per interval when nothing else answers', async () => {
      // The probe's own track must not make the next tick stand down.
      process.env.CANARY_INTERVAL_MS = '1000';

      startCanary(createLogger() as any);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3000);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(4);
    });

    it('stands down for a real track that lands while a failed probe runs', async () => {
      // Only a delivered probe stamps the platform, so a failed one must not hide a real track.
      process.env.CANARY_INTERVAL_MS = '1000';
      validateAndDownloadSubtitlesMock.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new YtDlpError('timeout');
      });

      startCanary(createLogger() as any);
      await jest.advanceTimersByTimeAsync(50);
      clearSubtitlesRateLimit(CANARY_URL);
      await jest.advanceTimersByTimeAsync(950);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
    });

    it('stands down for a real track that comes back after its own delivered probe', async () => {
      process.env.CANARY_INTERVAL_MS = '1000';

      startCanary(createLogger() as any);
      await jest.advanceTimersByTimeAsync(500);
      clearSubtitlesRateLimit(CANARY_URL);
      await jest.advanceTimersByTimeAsync(500);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
    });

    it('stays off when the interval is 0', () => {
      process.env.CANARY_INTERVAL_MS = '0';

      startCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
