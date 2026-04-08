import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseIntFromString } from '../env.js';
import {
  buildDockerImage,
  getDockerBuildContext,
  getDockerfileRelativePath,
  getShouldBuildDockerImages,
  runCommand,
} from './docker-utils.js';
import { getEnvVar } from './smoke-env.js';

const DEFAULT_MCP_IMAGE_NAME = 'artsamsonov/transcriptor-mcp';
const DEFAULT_MCP_PORT = 4200;
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

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

export function buildMcpImageRef(): string {
  const imageFromEnv = process.env.SMOKE_MCP_IMAGE;
  if (imageFromEnv && imageFromEnv.length > 0) {
    return imageFromEnv;
  }
  const imageName = getEnvVar('DOCKER_MCP_IMAGE', DEFAULT_MCP_IMAGE_NAME);
  const imageTag = getEnvVar('TAG', 'latest');
  return `${imageName}:${imageTag}`;
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

/** Optional Bearer for smoke tests against an MCP edge that requires auth (e.g. reverse proxy in front of mcp-proxy). */
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

async function checkMcpStreamableGetTranscript(baseUrl: string): Promise<void> {
  const fetchImpl: any = (globalThis as any).fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this Node.js runtime');
  }

  const videoUrl = getEnvVar('SMOKE_VIDEO_URL', DEFAULT_VIDEO_URL);
  const requestTimeoutMs = 60000;

  const initHeaders: Record<string, string> = {
    'content-type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...getMcpAuthHeaders(),
  };

  const initResponse = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify(MCP_INITIALIZE_BODY),
  });

  if (!initResponse.ok) {
    const text = await initResponse.text();
    throw new Error(`MCP streamable initialize failed with HTTP ${initResponse.status}: ${text}`);
  }

  const sessionId =
    initResponse.headers.get('mcp-session-id') ?? initResponse.headers.get('Mcp-Session-Id');
  if (!sessionId) {
    throw new Error('MCP streamable response missing mcp-session-id header');
  }

  const toolsCallBody = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_transcript',
      arguments: { url: videoUrl },
    },
  };

  const hasAbortController = (globalThis as any).AbortController !== undefined;
  const controller = hasAbortController ? new (globalThis as any).AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller) {
    timer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
  }

  const callResponse = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      ...initHeaders,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify(toolsCallBody),
    signal: controller?.signal,
  });

  if (timer) clearTimeout(timer);

  if (!callResponse.ok) {
    const text = await callResponse.text();
    throw new Error(
      `MCP tools/call get_transcript failed with HTTP ${callResponse.status}: ${text}`
    );
  }

  const callText = await callResponse.text();
  let callData: unknown;
  try {
    callData = JSON.parse(callText) as unknown;
  } catch {
    throw new Error(`MCP tools/call response is not valid JSON: ${callText.slice(0, 300)}`);
  }

  const result = (callData as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) {
    const err = (callData as { error?: unknown }).error;
    throw new Error(`MCP get_transcript failed: ${JSON.stringify(err ?? callData).slice(0, 400)}`);
  }

  const content = (result as { content?: unknown }).content;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const hasContent =
    (typeof content === 'string' && content.length > 0) ||
    (typeof structured === 'object' &&
      structured !== null &&
      typeof (structured as { text?: unknown }).text === 'string');

  if (!hasContent) {
    throw new Error(
      `MCP get_transcript result missing content or structuredContent.text: ${JSON.stringify(result).slice(0, 400)}`
    );
  }

  // eslint-disable-next-line no-console
  console.log('[smoke] MCP streamable get_transcript OK');
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

/**
 * Runs MCP E2E smoke against a Docker image: mcp-proxy + stdio child, then stdio-only check.
 * Expects the image to include mcp-proxy and `dist/mcp.js` (see Dockerfile --target mcp).
 */
export async function runMcpSmokeTest(mcpImage: string): Promise<void> {
  const mcpPort = parseIntFromString(
    getEnvVar('SMOKE_MCP_PORT', String(DEFAULT_MCP_PORT)),
    DEFAULT_MCP_PORT
  );
  if (mcpPort <= 0 || mcpPort > 65535) {
    throw new Error(`Invalid SMOKE_MCP_PORT value: ${mcpPort}`);
  }
  const mcpBaseUrl = getEnvVar('SMOKE_MCP_URL', `http://127.0.0.1:${mcpPort}`);
  const mcpContainerName =
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
    mcpImage,
    'mcp-proxy',
    '--pass-environment',
    '--host=0.0.0.0',
    '--port=4200',
    '--',
    'node',
    '--import',
    './dist/instrument.js',
    'dist/mcp.js',
  ];

  const mcpRunResult = await runCommand('docker', mcpRunArgs);
  if (mcpRunResult.code !== 0) {
    throw new Error(
      `Failed to start MCP Docker container (exit code ${mcpRunResult.code}, signal ${mcpRunResult.signal})`
    );
  }

  try {
    await waitForMcpReady(mcpBaseUrl, 60000);
    await checkMcpStreamable(mcpBaseUrl);
    await checkMcpStreamableGetTranscript(mcpBaseUrl);
    await checkMcpSse(mcpBaseUrl);
    await checkMcpStdio(mcpImage);
  } finally {
    // eslint-disable-next-line no-console
    console.log(`[smoke] Stopping MCP container ${mcpContainerName}`);
    await runCommand('docker', ['stop', mcpContainerName], { stdio: 'ignore' });
  }
}

export async function buildMcpImageIfNeeded(mcpImage: string): Promise<void> {
  if (!getShouldBuildDockerImages()) {
    return;
  }
  const contextDir = getDockerBuildContext();
  const dockerfileRel = getDockerfileRelativePath();
  await buildDockerImage(contextDir, dockerfileRel, 'mcp', mcpImage);
}

async function main(): Promise<void> {
  const mcpImage = buildMcpImageRef();
  await buildMcpImageIfNeeded(mcpImage);
  await runMcpSmokeTest(mcpImage);
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  await main();
  // eslint-disable-next-line no-console
  console.log('[smoke] MCP smoke test succeeded');
}
