import { setTimeout as sleep } from 'node:timers/promises';

import { parseIntFromString } from '../env.js';
import { runApiSmokeTest } from './api-checks.js';
import { buildDockerImagesIfNeeded, runCommand } from './docker-utils.js';
import { buildMcpImageRef, runMcpSmokeTest } from './mcp-smoke.js';
import { getEnvVar, isFlagSet } from './smoke-env.js';

const DEFAULT_IMAGE_NAME = 'artsamsonov/transcriptor-mcp-api';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_PORT = 33000;

function buildImageRef(): string {
  const imageFromEnv = process.env.SMOKE_IMAGE_API;
  if (imageFromEnv && imageFromEnv.length > 0) {
    return imageFromEnv;
  }

  const imageName = getEnvVar('DOCKER_API_IMAGE', DEFAULT_IMAGE_NAME);
  const imageTag = getEnvVar('TAG', DEFAULT_IMAGE_TAG);

  return `${imageName}:${imageTag}`;
}

async function waitForApiReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  const delays = [500, 1000, 1500, 2000, 2000, 3000, 3000];

  for (const delay of delays) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`API did not become ready within ${timeoutMs}ms`);
    }

    try {
      const healthUrl = `${baseUrl.replace(/\/$/, '')}/health`;
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Connection failures are expected while container is starting
    }

    await sleep(delay);
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms`);
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

  const skipMcp = isFlagSet('SMOKE_SKIP_MCP');
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
console.log(
  '[smoke] API smoke test succeeded' + (isFlagSet('SMOKE_SKIP_MCP') ? '' : ' (MCP checks passed)')
);
