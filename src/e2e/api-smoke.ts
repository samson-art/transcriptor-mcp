import { setTimeout as sleep } from 'node:timers/promises';

import { parseIntFromString } from '../env.js';
import { buildDockerImagesIfNeeded, runCommand } from './docker-utils.js';
import { buildMcpImageRef, runMcpSmokeTest } from './mcp-smoke.js';
import { getEnvVar } from './smoke-env.js';

const DEFAULT_IMAGE_NAME = 'artsamsonov/transcriptor-mcp-api';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_PORT = 33000;

const SWAGGER_DOCS_PATH = '/docs';

function buildImageRef(): string {
  const imageFromEnv = process.env.SMOKE_IMAGE_API;
  if (imageFromEnv && imageFromEnv.length > 0) {
    return imageFromEnv;
  }

  const imageName = getEnvVar('DOCKER_API_IMAGE', DEFAULT_IMAGE_NAME);
  const imageTag = getEnvVar('TAG', DEFAULT_IMAGE_TAG);

  return `${imageName}:${imageTag}`;
}

function getSkipMcp(): boolean {
  const v = process.env.SMOKE_SKIP_MCP;
  return v === '1' || v === 'true' || v === 'yes';
}

async function waitForApiReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;

  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const start = Date.now();

  const delays = [500, 1000, 1500, 2000, 2000, 3000, 3000];

  for (const delay of delays) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`API did not become ready within ${timeoutMs}ms`);
    }

    try {
      const healthUrl = `${baseUrl.replace(/\/$/, '')}/health`;
      const response = await fetchImpl(healthUrl, { method: 'GET' });
      if (response?.ok) {
        return;
      }
    } catch {
      // Connection failures are expected while container is starting
    }

    await sleep(delay);
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

async function checkSwaggerDocs(apiBaseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const response = await fetchImpl(`${apiBaseUrl}${SWAGGER_DOCS_PATH}`, { method: 'GET' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Swagger docs failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const html = await response.text();
  if (!html.includes('swagger') && !html.includes('openapi')) {
    throw new Error(
      `Swagger docs at ${SWAGGER_DOCS_PATH} did not return expected content (no swagger/openapi in body)`
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[smoke] ${SWAGGER_DOCS_PATH} OK (Swagger UI reachable)`);
}

async function runApiSmokeTest(apiBaseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  await checkSwaggerDocs(apiBaseUrl);

  const videoUrl = getEnvVar('SMOKE_VIDEO_URL', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const requestTimeoutMs = parseIntFromString(
    getEnvVar('SMOKE_API_REQUEST_TIMEOUT_MS', '90000'),
    90000
  );

  const hasAbortController = (globalThis as any).AbortController !== undefined;

  const controller = hasAbortController ? new (globalThis as any).AbortController() : null;

  let timer: NodeJS.Timeout | null = null;
  if (controller !== null) {
    timer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
  }

  try {
    const response = await fetchImpl(`${apiBaseUrl}/subtitles`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl,
        type: 'auto',
        lang: 'en',
      }),
      signal: controller?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Smoke request failed with HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as unknown;

    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { videoId?: unknown }).videoId !== 'string' ||
      typeof (data as { text?: unknown }).text !== 'string' ||
      typeof (data as { length?: unknown }).length !== 'number'
    ) {
      throw new Error(`Unexpected response shape from /subtitles: ${JSON.stringify(data)}`);
    }

    const { videoId, text, length } = data as {
      videoId: string;
      text: string;
      length: number;
    };

    if (!videoId || text.length === 0 || length <= 0) {
      throw new Error(
        `Invalid data in /subtitles response: videoId=${videoId}, text.length=${text.length}, length=${length}`
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[smoke] /subtitles OK for videoId=${videoId}, text.length=${text.length}, length=${length}`
    );
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  const image = buildImageRef();
  const port = parseIntFromString(getEnvVar('SMOKE_API_PORT', String(DEFAULT_PORT)), DEFAULT_PORT);

  if (port <= 0 || port > 65535) {
    throw new Error(`Invalid SMOKE_API_PORT value: ${port}`);
  }

  const containerName =
    getEnvVar('SMOKE_API_CONTAINER_NAME', 'transcriptor-mcp-api-smoke') + `-${Date.now()}`;

  const baseUrl = getEnvVar('SMOKE_API_URL', `http://127.0.0.1:${port}`);

  const skipMcp = getSkipMcp();
  const mcpImage = buildMcpImageRef();

  try {
    await buildDockerImagesIfNeeded(image, mcpImage, skipMcp);

    // eslint-disable-next-line no-console
    console.log(
      `[smoke] Starting API container from image ${image} on ${baseUrl} (container: ${containerName})`
    );

    const runArgs = [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-p',
      `${port}:3000`,
      '-e',
      'PORT=3000',
      image,
    ];

    const runResult = await runCommand('docker', runArgs);
    if (runResult.code !== 0) {
      throw new Error(
        `Failed to start Docker container for smoke test (exit code ${runResult.code}, signal ${runResult.signal})`
      );
    }

    await waitForApiReady(baseUrl, 60000);
    await runApiSmokeTest(baseUrl);

    if (!skipMcp) {
      await runMcpSmokeTest(mcpImage);
    }
  } finally {
    // eslint-disable-next-line no-console
    console.log(`[smoke] Stopping API container ${containerName}`);
    await runCommand('docker', ['stop', containerName], { stdio: 'ignore' });
  }
}

// Top-level await is fine here because this script is only used in tooling
await main();
// eslint-disable-next-line no-console
console.log('[smoke] API smoke test succeeded' + (getSkipMcp() ? '' : ' (MCP checks passed)'));
