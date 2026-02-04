import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_IMAGE_NAME = 'artsamsonov/yt-captions-downloader';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_PORT = 33000;
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function getEnvVar(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : defaultValue;
}

function buildImageRef(): string {
  const imageFromEnv = process.env.SMOKE_IMAGE_API;
  if (imageFromEnv && imageFromEnv.length > 0) {
    return imageFromEnv;
  }

  const imageName = getEnvVar('DOCKER_API_IMAGE', DEFAULT_IMAGE_NAME);
  const imageTag = getEnvVar('TAG', DEFAULT_IMAGE_TAG);

  return `${imageName}:${imageTag}`;
}

type RunCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function runCommand(
  command: string,
  args: string[],
  options: { stdio?: 'ignore' | 'inherit' } = {}
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function waitForApiReady(baseUrl: string, timeoutMs: number): Promise<void> {
  // Use Node 20 global fetch without relying on DOM typings

  const fetchImpl: any = (globalThis as any).fetch;

  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const start = Date.now();

  // Try fast initial attempts, then back off a bit
  const delays = [500, 1000, 1500, 2000, 2000, 3000, 3000];

  for (const delay of delays) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`API did not become ready within ${timeoutMs}ms`);
    }

    try {
      const response = await fetchImpl(baseUrl, { method: 'GET' });
      // Any HTTP status means Fastify is up and listening
      if (response) {
        return;
      }
    } catch {
      // Connection failures are expected while container is starting
    }

    await sleep(delay);
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

async function runApiSmokeTest(apiBaseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const videoUrl = getEnvVar('SMOKE_VIDEO_URL', DEFAULT_VIDEO_URL);
  const requestTimeoutMs = Number.parseInt(getEnvVar('SMOKE_API_REQUEST_TIMEOUT_MS', '90000'), 10);

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
  const port = Number.parseInt(getEnvVar('SMOKE_API_PORT', String(DEFAULT_PORT)), 10);

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SMOKE_API_PORT value: ${port}`);
  }

  const containerName =
    getEnvVar('SMOKE_API_CONTAINER_NAME', 'yt-captions-api-smoke') + `-${Date.now()}`;

  const baseUrl = getEnvVar('SMOKE_API_URL', `http://127.0.0.1:${port}`);

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

  // Wait until Fastify is accepting connections
  await waitForApiReady(baseUrl, 60000);
  // Run the actual HTTP-level smoke test
  await runApiSmokeTest(baseUrl);

  // eslint-disable-next-line no-console
  console.log(`[smoke] Stopping Docker container ${containerName}`);
  await runCommand('docker', ['stop', containerName], { stdio: 'ignore' });
}

// Top-level await is fine here because this script is only used in tooling
await main();
// eslint-disable-next-line no-console
console.log('[smoke] API smoke test succeeded');
