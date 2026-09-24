import * as Sentry from '@sentry/node';

import { ServerBusyError, YtDlpError } from './errors.js';
import { runCanary, startCanary, resetCanaryForTests } from './canary.js';
import { renderPrometheus } from './metrics.js';
import { clearSubtitlesRateLimit, resetSubtitleRateLimitsForTests } from './subtitle-rate-limit.js';
import * as validation from './validation.js';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

jest.mock('./validation.js', () => ({
  validateAndDownloadSubtitles: jest.fn(),
}));

const CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const captureMessageMock = Sentry.captureMessage as unknown as jest.Mock;
const validateAndDownloadSubtitlesMock = validation.validateAndDownloadSubtitles as jest.Mock;

function createLogger() {
  return { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

describe('canary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCanaryForTests();
    resetSubtitleRateLimitsForTests();
    delete process.env.CANARY_INTERVAL_MS;
    delete process.env.CANARY_URL;
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

    it('probes again once nothing has answered for a whole interval', async () => {
      process.env.CANARY_INTERVAL_MS = '1';
      clearSubtitlesRateLimit(CANARY_URL);
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });

      await new Promise((resolve) => setTimeout(resolve, 5));
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

    it('reports the recovery and starts a fresh streak', async () => {
      const logger = createLogger();
      validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
      await runCanary(logger as any);
      await runCanary(logger as any);
      captureMessageMock.mockClear();

      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });
      await runCanary(logger as any);

      expect(captureMessageMock).toHaveBeenCalledWith('canary: transcript path recovered', 'info');

      const metrics = await renderPrometheus();
      expect(metrics).toMatch(/^transcriptor_canary_ok\{[^}]*\} 1$/m);
      expect(metrics).toMatch(/^transcriptor_canary_last_success_timestamp_seconds\{[^}]*\} \d+/m);
    });

    it('reports the recovery once when real traffic ends a failure streak', async () => {
      // With the path failing, the first sign of life is often a user's call, not a probe:
      // the stand-down it causes must end the streak the way a good probe would.
      const logger = createLogger();
      validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
      await runCanary(logger as any);
      await runCanary(logger as any);
      captureMessageMock.mockClear();

      await new Promise((resolve) => setTimeout(resolve, 5));
      clearSubtitlesRateLimit(CANARY_URL);
      await runCanary(logger as any);
      await runCanary(logger as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(2);
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock).toHaveBeenCalledWith('canary: transcript path recovered', 'info');
      expect(await renderPrometheus()).toMatch(/^transcriptor_canary_ok\{[^}]*\} 1$/m);
    });

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

    afterEach(() => {
      jest.useRealTimers();
    });

    it('probes once per interval when nothing else answers', async () => {
      // The probe's own track must not make the next tick stand down.
      process.env.CANARY_INTERVAL_MS = '1000';

      startCanary(createLogger() as any);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3000);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(4);
    });

    it('stands down for a real track after its own probe, and probes once that track is an interval old', async () => {
      process.env.CANARY_INTERVAL_MS = '1000';

      startCanary(createLogger() as any);
      await jest.advanceTimersByTimeAsync(500);
      clearSubtitlesRateLimit(CANARY_URL);
      await jest.advanceTimersByTimeAsync(500);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(2);
    });

    it('stays off when the interval is 0', () => {
      process.env.CANARY_INTERVAL_MS = '0';

      startCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
