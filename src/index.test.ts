// Importing index.ts starts the server: keep start() waiting forever so it never listens.
jest.mock('./yt-dlp-check.js', () => ({ checkYtDlpAtStartup: () => new Promise(() => {}) }));
jest.mock('./lifecycle.js', () => ({ setupLifecycle: jest.fn() }));
// No loggerInstance gives Fastify's silent logger.
jest.mock('./logger-sentry-breadcrumbs.js', () => ({
  createLoggerWithSentryBreadcrumbs: () => undefined,
}));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setContext: jest.fn(), setTag: jest.fn(), setLevel: jest.fn() }),
}));

const MAX = 2;
let app: (typeof import('./index.js'))['fastify'];
const savedMax = process.env.RATE_LIMIT_MAX;

beforeAll(async () => {
  process.env.RATE_LIMIT_MAX = String(MAX);
  ({ fastify: app } = await import('./index.js'));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (savedMax === undefined) delete process.env.RATE_LIMIT_MAX;
  else process.env.RATE_LIMIT_MAX = savedMax;
});

it('has no /health/sentry-test: any caller could send Sentry an event per request', async () => {
  const res = await app.inject({ url: '/health/sentry-test' });
  expect(res.statusCode).toBe(404);
});

// The limit counts per client address across every limited route, so each case gets its own.
it.each([
  ['/health/ready', '10.0.0.1'],
  ['/failures', '10.0.0.2'],
  ['/changelogs', '10.0.0.3'],
])('%s is rate-limited', async (url, remoteAddress) => {
  for (let i = 0; i < MAX; i++) {
    const res = await app.inject({ url, remoteAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(MAX));
  }
  const over = await app.inject({ url, remoteAddress });
  expect(over.statusCode).toBe(429);
});

it.each(['/health', '/metrics'])('%s is never rate-limited (probes, scrapes)', async (url) => {
  const remoteAddress = '10.0.0.4';
  for (let i = 0; i < MAX; i++) await app.inject({ url: '/failures', remoteAddress });
  const spent = await app.inject({ url: '/failures', remoteAddress });
  expect(spent.statusCode).toBe(429);
  for (let i = 0; i <= MAX; i++) {
    const res = await app.inject({ url, remoteAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  }
});
