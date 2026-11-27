import { renderPrometheus } from './metrics.js';
import { buildRestApp } from './rest-app.js';
import {
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoChapters,
  validateAndFetchVideoInfo,
} from './validation.js';
import {
  INVALID_VIDEO_URL_MESSAGE,
  NotFoundError,
  ServerBusyError,
  UNKNOWN_FAILURE_MESSAGE,
  YtDlpError,
} from './errors.js';

// Nothing here may reach a platform: a spawn of yt-dlp or ffmpeg fails the test.
jest.mock('node:child_process', () => ({
  execFile: jest.fn(() => {
    throw new Error('a REST test spawned a process');
  }),
}));
// The real service runs by default, so a bad URL meets the real check. A test replaces one answer.
jest.mock('./validation.js', () => {
  const actual = jest.requireActual<typeof import('./validation.js')>('./validation.js');
  return {
    ...actual,
    validateAndDownloadSubtitles: jest.fn(actual.validateAndDownloadSubtitles),
    validateAndFetchAvailableSubtitles: jest.fn(actual.validateAndFetchAvailableSubtitles),
    validateAndFetchVideoInfo: jest.fn(actual.validateAndFetchVideoInfo),
    validateAndFetchVideoChapters: jest.fn(actual.validateAndFetchVideoChapters),
  };
});

const MAX = 2;
// Pin what a shell can set: Redis would keep Jest from exiting, and a short window makes 429s flaky.
Object.assign(process.env, {
  LOG_LEVEL: 'silent',
  CACHE_MODE: 'off',
  RATE_LIMIT_MAX: String(MAX),
  RATE_LIMIT_TIME_WINDOW: '1 minute',
});
const app = buildRestApp();

afterAll(() => app.close());

// /health/sentry-test let any caller send Sentry an event per request. /failures showed every
// caller the video URLs that other callers had sent.
it.each(['/health/sentry-test', '/failures'])(
  '%s answers 404 like any path with no route',
  async (url) => {
    const res = await app.inject({ url, remoteAddress: '10.0.0.1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: `Route GET:${url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  }
);

// Each raw path used to become a `route` value, about 14 series that prom-client never drops.
it('records every path with no route under route="unmatched"', async () => {
  const remoteAddress = '10.0.0.7';
  const series = async () =>
    (await renderPrometheus()).split('\n').filter((line) => line.startsWith('http_request'));
  // The first two create the 404 and the 429 series of the unmatched label.
  for (let i = 0; i <= MAX; i++) await app.inject({ url: `/first-${i}`, remoteAddress });
  const before = await series();
  for (let i = 0; i < 1000; i++) await app.inject({ url: `/unknown-${i}?q=${i}`, remoteAddress });
  const after = await series();

  expect(after.length).toBe(before.length);
  expect(after.join('\n')).not.toMatch(/route="\/(first|unknown)-/);
  expect(after).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^http_requests_total\{method="GET",route="unmatched",status_code="404"/
      ),
    ])
  );
});

// The limit counts per client address across every limited route, so each case gets its own.
it.each([
  ['/changelogs', 200, '10.0.0.3'],
  ['/no-such-route', 404, '10.0.0.5'],
])('%s is rate-limited', async (url, status, remoteAddress) => {
  for (let i = 0; i < MAX; i++) {
    const res = await app.inject({ url, remoteAddress });
    expect(res.statusCode).toBe(status);
    expect(res.headers['x-ratelimit-limit']).toBe(String(MAX));
  }
  const over = await app.inject({ url, remoteAddress });
  expect(over.statusCode).toBe(429);
});

it.each(['/health', '/health/ready'])('%s is never rate-limited (probes)', async (url) => {
  const remoteAddress = '10.0.0.4';
  for (let i = 0; i <= MAX; i++) await app.inject({ url: '/changelogs', remoteAddress });
  const res = await app.inject({ url, remoteAddress });
  expect(res.statusCode).toBe(200);
  expect(res.headers['x-ratelimit-limit']).toBeUndefined();
});

// A scrape every 15 s is 4 a minute. Each call serializes the whole registry.
it('/metrics has its own limit of 60 a minute per address', async () => {
  const remoteAddress = '10.0.0.6';
  // The global limit of this address is used up, and a scrape still gets through.
  for (let i = 0; i <= MAX; i++) await app.inject({ url: '/changelogs', remoteAddress });
  for (let i = 0; i < 60; i++) {
    const res = await app.inject({ url: '/metrics', remoteAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
  }
  expect((await app.inject({ url: '/metrics', remoteAddress })).statusCode).toBe(429);
  expect((await app.inject({ url: '/metrics', remoteAddress: '10.0.0.8' })).body).toContain(
    'http_requests_total'
  );
});

// `docker run --env-file` keeps the quotes. The plugin could not read the value, and every
// limited request answered 500. Zero did the same. A negative window, or one below 1 ms, turned
// the limit off.
it.each(['"1 minute"', '0', '-1 minute', '0.5'])(
  'does not start with the time window %s',
  (value) => {
    process.env.RATE_LIMIT_TIME_WINDOW = value;
    try {
      expect(() => buildRestApp()).toThrow(
        `RATE_LIMIT_TIME_WINDOW=${JSON.stringify(value)} is not a time window.`
      );
    } finally {
      process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    }
  }
);

// A route declared before the plugin has loaded is silently unlimited (2026-09-25), so walk them all.
it('limits every other route', async () => {
  await app.ready();
  // /metrics has its own limit, tested above.
  const skip = ['/health', '/health/ready', '/metrics'];
  const segments: string[] = [];
  const seen: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([│ ]*)[├└]── (.+) \((.+)\)$/.exec(line);
    if (!m) continue;
    segments.length = m[1].length / 4;
    segments.push(m[2]);
    const url = segments.join('');
    if (url.includes('*') || skip.includes(url)) continue;
    for (const method of m[3].split(', ').filter((x) => x === 'GET' || x === 'POST')) {
      const remoteAddress = `10.1.0.${seen.length}`;
      const res = await app.inject({ method, url, remoteAddress });
      seen.push(`${method} ${url}`);
      // The not-found handler is limited too: a 404 means the URL missed its route.
      expect(`${method} ${url} ${res.statusCode}`).not.toMatch(/ 404$/);
      expect(`${method} ${url} ${res.headers['x-ratelimit-limit']}`).toBe(
        `${method} ${url} ${MAX}`
      );
    }
  }
  expect(seen).toEqual(expect.arrayContaining(['GET /changelogs', 'POST /subtitles']));
});

describe('tool routes', () => {
  // A test that fails before its request reaches the service leaves its Once answer queued.
  // Drop it, so the next test gets the real service and fails for its own reason only.
  const actual = jest.requireActual<typeof import('./validation.js')>('./validation.js');
  afterEach(() => {
    for (const name of [
      'validateAndDownloadSubtitles',
      'validateAndFetchAvailableSubtitles',
      'validateAndFetchVideoInfo',
      'validateAndFetchVideoChapters',
    ] as const) {
      jest
        .requireMock<Record<string, jest.Mock>>('./validation.js')
        [name].mockReset()
        .mockImplementation(actual[name]);
    }
  });

  // The limit is MAX requests per address, so each request comes from a new one.
  let address = 0;
  const post = (url: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: `10.2.${Math.floor(address / 250)}.${address++ % 250}`,
    });

  const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const SRT =
    '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nworld\n';
  const subtitles = { videoId: 'dQw4w9WgXcQ', type: 'official', lang: 'en', subtitlesContent: SRT };
  const routes = [
    {
      url: '/subtitles',
      service: validateAndDownloadSubtitles as jest.Mock,
      result: subtitles,
      answer: {
        videoId: 'dQw4w9WgXcQ',
        type: 'official',
        lang: 'en',
        text: 'Hello world',
        length: 11,
      },
    },
    {
      url: '/subtitles/raw',
      service: validateAndDownloadSubtitles as jest.Mock,
      result: { ...subtitles, source: 'whisper' },
      answer: {
        videoId: 'dQw4w9WgXcQ',
        type: 'official',
        lang: 'en',
        format: 'srt',
        content: SRT,
        length: SRT.length,
        source: 'whisper',
      },
    },
    {
      url: '/subtitles/available',
      service: validateAndFetchAvailableSubtitles as jest.Mock,
      result: { videoId: 'dQw4w9WgXcQ', official: ['en'], auto: ['en', 'de'] },
      answer: { videoId: 'dQw4w9WgXcQ', official: ['en'], auto: ['en', 'de'] },
    },
    {
      url: '/video/info',
      service: validateAndFetchVideoInfo as jest.Mock,
      // A field outside the schema must not reach the caller.
      result: {
        videoId: 'dQw4w9WgXcQ',
        info: { title: 'T', duration: 212, viewCount: 5, extra: 1 },
      },
      answer: { videoId: 'dQw4w9WgXcQ', title: 'T', duration: 212, viewCount: 5 },
    },
    {
      url: '/video/chapters',
      service: validateAndFetchVideoChapters as jest.Mock,
      result: { videoId: 'dQw4w9WgXcQ', chapters: [{ startTime: 0, endTime: 60, title: 'Intro' }] },
      answer: { videoId: 'dQw4w9WgXcQ', chapters: [{ startTime: 0, endTime: 60, title: 'Intro' }] },
    },
  ];

  it.each(routes)('$url answers 200 with the fields of its schema', async (route) => {
    route.service.mockResolvedValueOnce(route.result);
    const res = await post(route.url, { url: VIDEO });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(route.answer);
    expect(route.service).toHaveBeenLastCalledWith({ url: VIDEO }, expect.anything());
  });

  it.each(routes)('$url answers 400 with the caller text to an unsupported URL', async (route) => {
    const res = await post(route.url, { url: 'https://example.com/watch?v=1' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid video URL', message: INVALID_VIDEO_URL_MESSAGE });
  });

  it.each(routes)('$url answers 400 to a body without url', async (route) => {
    const res = await post(route.url, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'Bad request',
      message: expect.stringContaining('url'),
    });
  });

  const errors = [
    [404, () => new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found'), 'Video not found'],
    [404, () => new YtDlpError('private'), 'Not found'],
    [502, () => new YtDlpError('bot_check'), 'Upstream error'],
    [503, () => new ServerBusyError(), 'Server busy'],
  ] as const;
  const cases = routes.flatMap((route) =>
    errors.map(([status, make, label]) => [route.url, status, label, route, make] as const)
  );

  it.each(cases)(
    '%s answers %i (%s) to a service error',
    async (_url, status, label, route, make) => {
      const error = make();
      route.service.mockRejectedValueOnce(error);
      const res = await post(route.url, { url: VIDEO });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: label, message: error.message });
    }
  );

  // Without lang, the track list comes back with the 404 (ADR 006).
  it('/subtitles answers 404 with the track list when it cannot pick a track', async () => {
    (validateAndDownloadSubtitles as jest.Mock).mockRejectedValueOnce(
      new NotFoundError('Pick a track.', 'Subtitles not found', { official: ['en'], auto: ['de'] })
    );
    const res = await post('/subtitles', { url: VIDEO });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'Subtitles not found',
      message: 'Pick a track.',
      available: { official: ['en'], auto: ['de'] },
    });
  });
});
