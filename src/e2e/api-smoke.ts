import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_IMAGE_NAME = 'artsamsonov/transcriptor-mcp-api';
const DEFAULT_IMAGE_TAG = 'latest';
const DEFAULT_PORT = 33000;
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const DEFAULT_MCP_IMAGE_NAME = 'artsamsonov/transcriptor-mcp';
const DEFAULT_MCP_PORT = 4200;

const MCP_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0' },
  },
};

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

function buildMcpImageRef(): string {
  const imageFromEnv = process.env.SMOKE_MCP_IMAGE;
  if (imageFromEnv && imageFromEnv.length > 0) {
    return imageFromEnv;
  }
  const imageName = getEnvVar('DOCKER_MCP_IMAGE', DEFAULT_MCP_IMAGE_NAME);
  const imageTag = getEnvVar('TAG', DEFAULT_IMAGE_TAG);
  return `${imageName}:${imageTag}`;
}

function getSkipMcp(): boolean {
  const v = process.env.SMOKE_SKIP_MCP;
  return v === '1' || v === 'true' || v === 'yes';
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

function runCommandWithStdin(
  command: string,
  args: string[],
  stdinInput: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (resolved) return;
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          ('result' in parsed || 'error' in parsed)
        ) {
          resolved = true;
          clearTimeout(timeout);
          child.kill();
          resolve(trimmed);
        }
      } catch {
        // Not JSON or not a response; skip
      }
    });

    rl.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error('No JSON-RPC response line received from MCP stdio'));
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.stderr?.on('data', (data: Buffer | string) => {
      // Log but do not fail
      process.stderr.write(data);
    });

    child.stdin?.write(stdinInput, (err: Error | null | undefined) => {
      if (err && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
        return;
      }
      child.stdin?.end();
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

async function waitForMcpReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const start = Date.now();
  const delays = [500, 1000, 1500, 2000, 2000, 3000, 3000];

  for (const delay of delays) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`MCP server did not become ready within ${timeoutMs}ms`);
    }

    try {
      const response = await fetchImpl(`${baseUrl}/sse`, { method: 'GET' });
      if (response?.ok) {
        return;
      }
    } catch {
      // Connection failures expected while container is starting
    }

    await sleep(delay);
  }

  throw new Error(`MCP server did not become ready within ${timeoutMs}ms`);
}

function getMcpAuthHeaders(): Record<string, string> {
  const token = process.env.SMOKE_MCP_AUTH_TOKEN?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function checkMcpStreamable(baseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...getMcpAuthHeaders(),
  };

  const response = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(MCP_INITIALIZE_BODY),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP streamable POST /mcp failed with HTTP ${response.status}: ${text}`);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  const bodyText = await response.text();

  let data: unknown;
  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(bodyText) as unknown;
    } catch {
      throw new Error(`MCP /mcp response is not valid JSON: ${bodyText.slice(0, 200)}`);
    }
  } else if (contentType.includes('text/event-stream')) {
    const dataLine = bodyText.split('\n').find((line: string) => line.startsWith('data: '));
    if (!dataLine) {
      throw new Error(`MCP /mcp SSE response has no data line: ${bodyText.slice(0, 300)}`);
    }
    try {
      data = JSON.parse(dataLine.slice(6).trim()) as unknown;
    } catch {
      throw new Error(`MCP /mcp SSE data is not valid JSON: ${dataLine.slice(0, 200)}`);
    }
  } else {
    throw new Error(`MCP /mcp unexpected Content-Type: ${contentType}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error(`MCP /mcp response is not an object: ${JSON.stringify(data)}`);
  }

  const result = (data as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) {
    throw new Error(`MCP /mcp response missing result: ${JSON.stringify(data)}`);
  }

  const r = result as { serverInfo?: unknown; capabilities?: unknown };
  if (r.serverInfo === undefined && r.capabilities === undefined) {
    throw new Error(`MCP /mcp result missing serverInfo/capabilities: ${JSON.stringify(result)}`);
  }

  // eslint-disable-next-line no-console
  console.log('[smoke] MCP streamable /mcp OK (initialize response valid)');
}

async function checkMcpSse(baseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const headers = getMcpAuthHeaders();
  const hasAbortController = (globalThis as any).AbortController !== undefined;
  const controller = hasAbortController ? new (globalThis as any).AbortController() : null;
  const timeoutMs = 5000;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  }

  try {
    const response = await fetchImpl(`${baseUrl}/sse`, {
      method: 'GET',
      headers,
      signal: controller?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MCP GET /sse failed with HTTP ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`MCP /sse Content-Type expected text/event-stream, got: ${contentType}`);
    }

    // Abort so we don't leave the SSE stream open
    controller?.abort();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  // eslint-disable-next-line no-console
  console.log('[smoke] MCP GET /sse OK (event stream)');
}

async function checkMcpStdio(imageRef: string): Promise<void> {
  const inputLine = JSON.stringify(MCP_INITIALIZE_BODY) + '\n';
  const timeoutMs = 15000;

  const line = await runCommandWithStdin(
    'docker',
    ['run', '--rm', '-i', imageRef],
    inputLine,
    timeoutMs
  );

  let data: unknown;
  try {
    data = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`MCP stdio response is not valid JSON: ${line.slice(0, 200)}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error(`MCP stdio response is not an object: ${JSON.stringify(data)}`);
  }

  const result = (data as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) {
    throw new Error(`MCP stdio response missing result: ${JSON.stringify(data)}`);
  }

  const r = result as { serverInfo?: unknown; capabilities?: unknown };
  if (r.serverInfo === undefined && r.capabilities === undefined) {
    throw new Error(`MCP stdio result missing serverInfo/capabilities: ${JSON.stringify(result)}`);
  }

  // eslint-disable-next-line no-console
  console.log('[smoke] MCP stdio OK (initialize response valid)');
}

const SWAGGER_DOCS_PATH = '/docs';

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
    getEnvVar('SMOKE_API_CONTAINER_NAME', 'transcriptor-mcp-api-smoke') + `-${Date.now()}`;

  const baseUrl = getEnvVar('SMOKE_API_URL', `http://127.0.0.1:${port}`);

  const skipMcp = getSkipMcp();
  let mcpContainerName: string | null = null;
  const mcpPort = Number.parseInt(getEnvVar('SMOKE_MCP_PORT', String(DEFAULT_MCP_PORT)), 10);
  if (Number.isNaN(mcpPort) || mcpPort <= 0 || mcpPort > 65535) {
    throw new Error(`Invalid SMOKE_MCP_PORT value: ${mcpPort}`);
  }
  const mcpBaseUrl = getEnvVar('SMOKE_MCP_URL', `http://127.0.0.1:${mcpPort}`);
  const mcpImage = buildMcpImageRef();

  try {
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
      mcpContainerName =
        getEnvVar('SMOKE_MCP_CONTAINER_NAME', 'transcriptor-mcp-smoke') + `-${Date.now()}`;

      // eslint-disable-next-line no-console
      console.log(
        `[smoke] Starting MCP container from image ${mcpImage} on ${mcpBaseUrl} (container: ${mcpContainerName})`
      );

      const mcpRunArgs = [
        'run',
        '--rm',
        '-d',
        '--name',
        mcpContainerName,
        '-p',
        `${mcpPort}:4200`,
        '-e',
        'MCP_PORT=4200',
        '-e',
        'MCP_HOST=0.0.0.0',
      ];

      const authToken = process.env.SMOKE_MCP_AUTH_TOKEN?.trim();
      if (authToken) {
        mcpRunArgs.push('-e', `MCP_AUTH_TOKEN=${authToken}`);
      }

      mcpRunArgs.push(mcpImage, 'npm', 'run', 'start:mcp:http');

      const mcpRunResult = await runCommand('docker', mcpRunArgs);
      if (mcpRunResult.code !== 0) {
        throw new Error(
          `Failed to start MCP Docker container (exit code ${mcpRunResult.code}, signal ${mcpRunResult.signal})`
        );
      }

      await waitForMcpReady(mcpBaseUrl, 60000);
      await checkMcpStreamable(mcpBaseUrl);
      await checkMcpSse(mcpBaseUrl);
      await checkMcpStdio(mcpImage);

      // eslint-disable-next-line no-console
      console.log(`[smoke] Stopping MCP container ${mcpContainerName}`);
      await runCommand('docker', ['stop', mcpContainerName], { stdio: 'ignore' });
      mcpContainerName = null;
    }
  } finally {
    // eslint-disable-next-line no-console
    console.log(`[smoke] Stopping API container ${containerName}`);
    await runCommand('docker', ['stop', containerName], { stdio: 'ignore' });
    if (mcpContainerName) {
      // eslint-disable-next-line no-console
      console.log(`[smoke] Stopping MCP container ${mcpContainerName}`);
      await runCommand('docker', ['stop', mcpContainerName], { stdio: 'ignore' });
    }
  }
}

// Top-level await is fine here because this script is only used in tooling
await main();
// eslint-disable-next-line no-console
console.log('[smoke] API smoke test succeeded' + (getSkipMcp() ? '' : ' (MCP checks passed)'));
