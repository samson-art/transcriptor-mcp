import { renderPrometheus } from './metrics.js';

// Importing index.ts starts the server: keep start() waiting forever so it never listens.
jest.mock('./yt-dlp-check.js', () => ({ checkYtDlpAtStartup: () => new Promise(() => {}) }));
jest.mock('./lifecycle.js', () => ({ setupLifecycle: jest.fn() }));

const MAX = 2;
let app: (typeof import('./index.js'))['fastify'];

beforeAll(async () => {
  // Pin what a shell can set: Redis would keep Jest from exiting, and a short window makes 429s flaky.
  Object.assign(process.env, {
    LOG_LEVEL: 'silent',
    CACHE_MODE: 'off',
    RATE_LIMIT_MAX: String(MAX),
    RATE_LIMIT_TIME_WINDOW: '1 minute',
  });
  ({ fastify: app } = await import('./index.js'));
});

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
  async (value) => {
    process.env.RATE_LIMIT_TIME_WINDOW = value;
    try {
      await jest.isolateModulesAsync(async () => {
        await expect(import('./index.js')).rejects.toThrow(
          `RATE_LIMIT_TIME_WINDOW=${JSON.stringify(value)} is not a time window.`
        );
      });
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
