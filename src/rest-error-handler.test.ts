import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import * as Sentry from '@sentry/node';
import pino from 'pino';
import {
  INVALID_VIDEO_URL_MESSAGE,
  NotFoundError,
  ServerBusyError,
  UNEXPECTED_ERROR_MESSAGE,
  ValidationError,
  YtDlpError,
} from './errors.js';
import { renderPrometheus } from './metrics.js';
import { restErrorHandler } from './rest-error-handler.js';

const mockScope = { setContext: jest.fn(), setTag: jest.fn() };
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: (fn: (scope: unknown) => void) => fn(mockScope),
}));

// What GET /changelogs answered in the API image before the file was copied in.
const PATH_ERROR = "ENOENT: no such file or directory, open '/app/CHANGELOG.md'";
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const WARN = 40;
const ERROR = 50;

// The lines the handler writes at warn and above, as pino writes them.
const logLines: Array<Record<string, unknown>> = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({
    loggerInstance: pino(
      { level: 'warn' },
      { write: (line: string) => logLines.push(JSON.parse(line)) }
    ) as FastifyBaseLogger,
  });
  app.setErrorHandler(restErrorHandler);
  await app.register(rateLimit, { global: false });
  app.post('/plain', () => {
    throw new Error(PATH_ERROR);
  });
  app.post(
    '/schema',
    {
      schema: {
        body: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      },
    },
    () => ({ ok: true })
  );
  app.get('/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, () => ({
    ok: true,
  }));
  app.get('/invalid', () => {
    throw new ValidationError(INVALID_VIDEO_URL_MESSAGE, 'Invalid video URL');
  });
  app.get('/not-found', () => {
    throw new NotFoundError('No subtitles.', 'Subtitles not found', { official: ['en'] });
  });
  app.get('/upstream', () => {
    throw new YtDlpError('bot_check');
  });
  app.get('/busy', () => {
    throw new ServerBusyError();
  });
  app.get('/foreign-404', () => {
    throw Object.assign(new Error('Plugin fault.'), { statusCode: 404 });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  jest.clearAllMocks();
  logLines.length = 0;
});

describe('restErrorHandler', () => {
  it('answers an unplanned error with the generic text, never its message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/plain',
      payload: { url: VIDEO_URL },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal server error',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    // The operator still gets the real error: in a log line that carries the request id,
    // and in Sentry with the video URL the caller sent.
    expect(logLines).toEqual([
      expect.objectContaining({
        level: ERROR,
        reqId: expect.any(String),
        err: expect.objectContaining({ message: PATH_ERROR }),
      }),
    ]);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: PATH_ERROR })
    );
    expect(mockScope.setContext).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ requestUrl: VIDEO_URL })
    );
  });

  it.each([
    ['fails the schema', {}, "body must have required property 'url'"],
    ['is not JSON', '{ not json', expect.stringContaining('JSON')],
  ])("keeps Fastify's 400 and its message for a body that %s", async (_name, payload, message) => {
    const response = await app.inject({
      method: 'POST',
      url: '/schema',
      payload,
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Bad request', message });
    // The caller's mistake is a warning, and it is not a Sentry event.
    expect(logLines).toEqual([expect.objectContaining({ level: WARN })]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('answers 429 over the rate limit', async () => {
    await app.inject({ method: 'GET', url: '/limited' });
    const response = await app.inject({ method: 'GET', url: '/limited' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: 'Too many requests',
      message: expect.stringMatching(/Rate limit exceeded/),
    });
    // A burst of rejected requests must not become a burst of Sentry events.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['/invalid', 400, { error: 'Invalid video URL', message: INVALID_VIDEO_URL_MESSAGE }, WARN, 0],
    [
      '/not-found',
      404,
      { error: 'Subtitles not found', message: 'No subtitles.', available: { official: ['en'] } },
      WARN,
      0,
    ],
    [
      '/upstream',
      502,
      { error: 'Upstream error', message: new YtDlpError('bot_check').message },
      ERROR,
      1,
    ],
    // Load shedding is a state of the server under a burst, not a fault.
    ['/busy', 503, { error: 'Server busy', message: new ServerBusyError().message }, WARN, 0],
  ])(
    'keeps status, label and text of our own error at %s',
    async (url, status, body, level, sentryEvents) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(body);
      expect(logLines).toEqual([expect.objectContaining({ level })]);
      expect(Sentry.captureException).toHaveBeenCalledTimes(sentryEvents);
    }
  );

  it('counts only our own 404s as planned', async () => {
    await app.inject({ method: 'GET', url: '/not-found' });
    const foreign = await app.inject({ method: 'GET', url: '/foreign-404' });

    expect(foreign.json()).toEqual({ error: 'Not found', message: 'Plugin fault.' });
    const metrics = await renderPrometheus();
    expect(metrics).toContain('http_404_expected_total{method="GET",route="/not-found"');
    expect(metrics).not.toContain('route="/foreign-404"');
  });
});
