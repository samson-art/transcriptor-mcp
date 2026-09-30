import { existsSync, readFileSync } from 'node:fs';

import { runApiSmokeTest } from './api-checks.js';

const BASE = 'http://127.0.0.1:33000';
const originalEnv = process.env;
const originalFetch = globalThis.fetch;

let fetchMock: jest.Mock;
let changelogMissing: boolean;
let subtitlesHang: boolean;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SMOKE_SKIP_TRANSCRIPT;
  delete process.env.SMOKE_API_REQUEST_TIMEOUT_MS;
  changelogMissing = false;
  subtitlesHang = false;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // A healthy API image: swagger at /docs, the checkout's CHANGELOG.md at /changelogs.
  fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const path = url.slice(BASE.length);
    if (path === '/docs') return Promise.resolve(new Response('<div id="swagger-ui"></div>'));
    if (path === '/changelogs') {
      return Promise.resolve(
        changelogMissing
          ? new Response('{"error":"Internal server error"}', { status: 500 })
          : new Response(readFileSync('CHANGELOG.md', 'utf-8'), {
              headers: { 'content-type': 'text/markdown; charset=utf-8' },
            })
      );
    }
    if (subtitlesHang) {
      // A server that never answers: only the request's own signal can end the wait.
      const signal = init?.signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason as Error))
      );
    }
    return Promise.resolve(Response.json({ videoId: 'dQw4w9WgXcQ', text: 'never', length: 5 }));
  });
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
});

const calledPaths = () => fetchMock.mock.calls.map(([url]) => (url as string).slice(BASE.length));

describe('runApiSmokeTest', () => {
  // CI must not spend caption quota (ADR 002): the flag skips the one call that reaches YouTube.
  it('with SMOKE_SKIP_TRANSCRIPT=1 it checks /docs and /changelogs and sends no /subtitles request', async () => {
    process.env.SMOKE_SKIP_TRANSCRIPT = '1';

    await runApiSmokeTest(BASE);

    expect(calledPaths()).toEqual(['/docs', '/changelogs']);
  });

  it('without the flag it also checks /subtitles', async () => {
    await runApiSmokeTest(BASE);

    expect(calledPaths()).toEqual(['/docs', '/changelogs', '/subtitles']);
  });

  it('an image without CHANGELOG.md fails the smoke', async () => {
    process.env.SMOKE_SKIP_TRANSCRIPT = '1';
    changelogMissing = true;

    await expect(runApiSmokeTest(BASE)).rejects.toThrow('/changelogs failed: HTTP 500');
  });

  it('the /subtitles request gives up after SMOKE_API_REQUEST_TIMEOUT_MS', async () => {
    process.env.SMOKE_API_REQUEST_TIMEOUT_MS = '20';
    subtitlesHang = true;

    await expect(runApiSmokeTest(BASE)).rejects.toThrow('aborted');
  }, 2000);
});

describe('publish-docker.yml', () => {
  it('runs the API smoke with the transcript skipped before it pushes the API image', () => {
    const workflow = readFileSync('.github/workflows/publish-docker.yml', 'utf-8');
    const smoke = workflow.split('- name: ').find((step) => step.includes('npm run test:e2e:api'));

    expect(smoke).toContain('SMOKE_SKIP_TRANSCRIPT=1');
    // Without these two, docker pulls the published :latest images and tests those instead.
    expect(smoke).toContain('SMOKE_IMAGE_API=transcriptor-mcp-api:smoke');
    expect(smoke).toContain('SMOKE_SKIP_MCP=1');
    // Older tags would call YouTube. If the guarded file is renamed, the smoke silently never runs.
    expect(smoke).toContain("if: hashFiles('src/e2e/api-checks.ts') != ''");
    expect(existsSync('src/e2e/api-checks.ts')).toBe(true);
    expect(workflow.indexOf('npm run test:e2e:api')).toBeLessThan(
      workflow.indexOf('name: Build and push REST API image')
    );
  });
});
