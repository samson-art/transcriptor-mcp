import Fastify, { type FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { YtDlpError } from './errors.js';
import { restErrorHandler } from './rest-error-handler.js';
import {
  assertSubtitlesNotRateLimited,
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';

// The events the real SDK sends, with the options instrument.ts gives it. Only the DSN and
// the transport are the test's: the transport keeps each event here and sends nothing.
const mockSent: Sentry.Event[] = [];
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual<typeof Sentry>('@sentry/node');
  return {
    ...actual,
    init: (options: Sentry.NodeOptions) =>
      actual.init({
        ...options,
        dsn: 'https://key@sentry.invalid/1',
        transport: () => ({
          send: (envelope: [unknown, Array<[{ type: string }, unknown]>]) => {
            for (const [item, payload] of envelope[1]) {
              if (item.type === 'event') mockSent.push(payload as Sentry.Event);
            }
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
      }),
  };
});

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const videoUrl = (i: number) => `https://www.youtube.com/watch?v=${String(i).padStart(11, 'v')}`;

let app: FastifyInstance;

beforeAll(async () => {
  // Tracing on: this is what adds Sentry's Fastify integration.
  process.env.SENTRY_TRACES_SAMPLE_RATE = '1';
  await import('./instrument.js');
  app = Fastify();
  app.setErrorHandler(restErrorHandler);
  app.post('/subtitles', (request) => {
    const { url } = request.body as { url: string };
    assertSubtitlesNotRateLimited(url);
    // What a platform run that answers 429 leaves behind (youtube.ts).
    noteSubtitlesRateLimited(url);
    throw new YtDlpError('rate_limited');
  });
  app.post('/fails', () => {
    throw new Error('Unplanned fault.');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Sentry.close();
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});

beforeEach(() => {
  resetSubtitleRateLimitsForTests();
  mockSent.length = 0;
});

const post = (url: string, videoUrl: string) =>
  app.inject({ method: 'POST', url, payload: { url: videoUrl } });

describe('Sentry events', () => {
  it('sends the 429 of a platform run once, and nothing for the 50 calls its hold answers', async () => {
    expect((await post('/subtitles', videoUrl(0))).statusCode).toBe(502);
    for (let i = 1; i <= 50; i++) {
      const held = await post('/subtitles', videoUrl(i));
      // The caller's answer does not change: the same 502 and text as the 429 itself.
      expect(held.statusCode).toBe(502);
      expect(held.json().message).toBe(new YtDlpError('rate_limited').message);
    }
    await Sentry.flush();

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].tags).toMatchObject({ yt_dlp_reason: 'rate_limited' });
  });

  it('sends a REST route error once, with the route tag and the requested URL', async () => {
    expect((await post('/fails', VIDEO_URL)).statusCode).toBe(500);
    await Sentry.flush();

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].tags).toMatchObject({ route: '/fails' });
    expect(mockSent[0].contexts?.request).toMatchObject({ requestUrl: VIDEO_URL });
  });
});
