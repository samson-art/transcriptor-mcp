import * as Sentry from '@sentry/node';

import { ServerBusyError, YtDlpError } from './errors.js';
import { runCanary, startCanary, resetCanaryForTests } from './canary.js';
import { renderPrometheus } from './metrics.js';
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
  const logger = {
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    child: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

describe('canary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCanaryForTests();
    delete process.env.CANARY_INTERVAL_MS;
    delete process.env.CANARY_URL;
  });

  describe('runCanary', () => {
    it('asks for one language explicitly, so a probe costs a single yt-dlp call', async () => {
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auto', lang: 'en' }),
        expect.anything()
      );
    });

    it('uses CANARY_URL when set', async () => {
      process.env.CANARY_URL = 'https://www.youtube.com/watch?v=other123';
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });

      await runCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://www.youtube.com/watch?v=other123' }),
        expect.anything()
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

      // Two more failures are needed before the next alert.
      validateAndDownloadSubtitlesMock.mockRejectedValue(new YtDlpError('rate_limited'));
      captureMessageMock.mockClear();
      await runCanary(logger as any);
      expect(captureMessageMock).not.toHaveBeenCalled();
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
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      jest.useFakeTimers();
      process.env.NODE_ENV = 'production';
      validateAndDownloadSubtitlesMock.mockResolvedValue({ subtitlesContent: 'hello' });
    });

    afterEach(() => {
      jest.useRealTimers();
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('probes at boot and then on the interval', () => {
      process.env.CANARY_INTERVAL_MS = '1000';

      const timer = startCanary(createLogger() as any);

      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2000);
      expect(validateAndDownloadSubtitlesMock).toHaveBeenCalledTimes(3);

      if (timer) clearInterval(timer);
    });

    it('stays off when the interval is 0', () => {
      process.env.CANARY_INTERVAL_MS = '0';

      expect(startCanary(createLogger() as any)).toBeUndefined();
      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
    });

    it('stays off under NODE_ENV=test so suites never reach the network', () => {
      process.env.NODE_ENV = 'test';

      expect(startCanary(createLogger() as any)).toBeUndefined();
      expect(validateAndDownloadSubtitlesMock).not.toHaveBeenCalled();
    });
  });
});
