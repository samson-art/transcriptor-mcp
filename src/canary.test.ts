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
      clearSubtitlesRateLimit('https://www.youtube.com/watch?v=jNQXAC9IVRw');

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
      expect(await renderPrometheus()).toMatch(/transcriptor_canary_ok\{[^}]*\} 1/);
    });

    it('probes again once nothing has answered for a whole interval', async () => {
      process.env.CANARY_INTERVAL_MS = '1';
      clearSubtitlesRateLimit('https://www.youtube.com/watch?v=jNQXAC9IVRw');
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
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('probes at boot and then on the interval', () => {
      process.env.CANARY_INTERVAL_MS = '1000';

      startCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2000);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(3);
    });

    it('stays off when the interval is 0', () => {
      process.env.CANARY_INTERVAL_MS = '0';

      startCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
