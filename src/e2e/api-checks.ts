import { readChangelog } from '../changelog.js';
import { parseIntFromString } from '../env.js';
import { getEnvVar, isFlagSet } from './smoke-env.js';

async function checkGet(
  apiBaseUrl: string,
  path: string,
  isExpected: (body: string, contentType: string) => boolean
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !isExpected(body, contentType)) {
    throw new Error(
      `${path} failed: HTTP ${response.status}, ${contentType}, ${body.length} bytes: ${body.slice(0, 200)}`
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[smoke] ${path} OK`);
}

/**
 * The REST checks of the API smoke. `SMOKE_SKIP_TRANSCRIPT` skips `/subtitles`, the one call that
 * reaches YouTube, so CI spends no caption quota (ADR 002).
 */
export async function runApiSmokeTest(apiBaseUrl: string): Promise<void> {
  await checkGet(apiBaseUrl, '/docs', (body) => /swagger|openapi/.test(body));
  // The route reads CHANGELOG.md from the image at each request. An image without it answers 500.
  const changelog = await readChangelog();
  await checkGet(
    apiBaseUrl,
    '/changelogs',
    (body, contentType) => contentType.startsWith('text/markdown') && body === changelog
  );

  if (isFlagSet('SMOKE_SKIP_TRANSCRIPT')) return;

  const videoUrl = getEnvVar('SMOKE_VIDEO_URL', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const requestTimeoutMs = parseIntFromString(
    getEnvVar('SMOKE_API_REQUEST_TIMEOUT_MS', '90000'),
    90000
  );

  // The signal also covers the body read below.
  const response = await fetch(`${apiBaseUrl}/subtitles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: videoUrl, type: 'auto', lang: 'en' }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Smoke request failed with HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { videoId?: unknown }).videoId !== 'string' ||
    typeof (data as { text?: unknown }).text !== 'string' ||
    typeof (data as { length?: unknown }).length !== 'number'
  ) {
    throw new Error(`Unexpected response shape from /subtitles: ${JSON.stringify(data)}`);
  }

  const { videoId, text, length } = data as { videoId: string; text: string; length: number };

  if (!videoId || text.length === 0 || length <= 0) {
    throw new Error(
      `Invalid data in /subtitles response: videoId=${videoId}, text.length=${text.length}, length=${length}`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[smoke] /subtitles OK for videoId=${videoId}, text.length=${text.length}, length=${length}`
  );
}
