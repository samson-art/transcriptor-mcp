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

it('has no /health/sentry-test: any caller could send Sentry an event per request', async () => {
  const res = await app.inject({ url: '/health/sentry-test' });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({
    message: 'Route GET:/health/sentry-test not found',
    error: 'Not Found',
    statusCode: 404,
  });
});

// The limit counts per client address across every limited route, so each case gets its own.
it.each([
  ['/failures', 200, '10.0.0.2'],
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

it.each(['/health', '/health/ready', '/metrics'])(
  '%s is never rate-limited (probes, scrapes)',
  async (url) => {
    const remoteAddress = '10.0.0.4';
    for (let i = 0; i <= MAX; i++) await app.inject({ url: '/failures', remoteAddress });
    const res = await app.inject({ url, remoteAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  }
);

// A route declared before the plugin has loaded is silently unlimited (2026-09-25), so walk them all.
it('limits every other route', async () => {
  await app.ready();
  const unlimited = ['/health', '/health/ready', '/metrics'];
  const segments: string[] = [];
  const seen: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([│ ]*)[├└]── (.+) \((.+)\)$/.exec(line);
    if (!m) continue;
    segments.length = m[1].length / 4;
    segments.push(m[2]);
    const url = segments.join('');
    if (url.includes('*') || unlimited.includes(url)) continue;
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
  expect(seen).toEqual(expect.arrayContaining(['GET /failures', 'POST /subtitles']));
});
