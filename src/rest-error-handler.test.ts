import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import * as Sentry from '@sentry/node';
import { NotFoundError, ServerBusyError, UNEXPECTED_ERROR_MESSAGE, YtDlpError } from './errors.js';
import { restErrorHandler } from './rest-error-handler.js';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setContext: jest.fn(), setTag: jest.fn(), setLevel: jest.fn() }),
}));

// What GET /changelogs answered in the API image before the file was copied in.
const PATH_ERROR = "ENOENT: no such file or directory, open '/app/CHANGELOG.md'";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(restErrorHandler);
  await app.register(rateLimit, { global: false });
  app.get('/plain', () => {
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
  app.get('/not-found', () => {
    throw new NotFoundError('No subtitles.', 'Subtitles not found', { official: ['en'] });
  });
  app.get('/upstream', () => {
    throw new YtDlpError('bot_check');
  });
  app.get('/busy', () => {
    throw new ServerBusyError();
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(Sentry.captureException).mockClear();
});

describe('restErrorHandler', () => {
  it('answers an unplanned error with the generic text, never its message', async () => {
    const logError = jest.spyOn(app.log, 'error');

    const response = await app.inject({ method: 'GET', url: '/plain' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal server error',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    expect(response.body).not.toContain('/app/');
    // The operator still gets the real error, in the log and in Sentry.
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ message: PATH_ERROR }));
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: PATH_ERROR })
    );
  });

  it("keeps Fastify's 400 and its message for a body that fails the schema", async () => {
    const response = await app.inject({ method: 'POST', url: '/schema', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad request',
      message: "body must have required property 'url'",
    });
  });

  it('answers 400 to a body that is not JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/schema',
      payload: '{ not json',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Bad request');
  });

  it('answers 429 over the rate limit', async () => {
    await app.inject({ method: 'GET', url: '/limited' });
    const response = await app.inject({ method: 'GET', url: '/limited' });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('Too many requests');
    expect(response.json().message).toMatch(/Rate limit exceeded/);
    // A burst of rejected requests must not become a burst of Sentry events.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps status, label and text of our own errors', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/not-found' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      error: 'Subtitles not found',
      message: 'No subtitles.',
      available: { official: ['en'] },
    });

    const upstream = await app.inject({ method: 'GET', url: '/upstream' });
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json()).toEqual({
      error: 'Upstream error',
      message: new YtDlpError('bot_check').message,
    });

    const busy = await app.inject({ method: 'GET', url: '/busy' });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ error: 'Server busy', message: new ServerBusyError().message });
  });
});
