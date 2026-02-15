import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type {
  SSEServerTransport,
  SSEServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/sse.js';
import { createSseTransport } from './sse-transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { close as closeCache } from './cache.js';
import {
  getFailedSubtitlesUrls,
  renderPrometheus,
  setMcpSessionCount,
  setMetricsService,
} from './metrics.js';
import { ensureAuth, getHeaderValue } from './mcp-auth.js';
import { createMcpServer } from './mcp-core.js';
import { version } from './version.js';
import * as Sentry from '@sentry/node';
import { checkYtDlpAtStartup } from './yt-dlp-check.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';

setMetricsService('mcp');

type StreamableSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
};

type SseSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: SSEServerTransport;
  createdAt: number;
};

const app = Fastify({ loggerInstance: createLoggerWithSentryBreadcrumbs() });

const streamableSessions = new Map<string, StreamableSession>();
const sseSessions = new Map<string, SseSession>();

const mcpPort = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 4200;
const mcpHost = process.env.MCP_HOST || '0.0.0.0';
const authToken = process.env.MCP_AUTH_TOKEN?.trim();

function getMcpPublicUrls(): string[] {
  const urlsVar = process.env.MCP_PUBLIC_URLS?.trim();
  if (urlsVar) {
    const parsed = urlsVar
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  const single = process.env.MCP_PUBLIC_URL?.trim();
  if (single) return [single];
  return [];
}

const mcpPublicUrls = getMcpPublicUrls();

const SMITHERY_HOST = 'server.smithery.ai';

function isSmitheryProxyRequest(request: FastifyRequest): boolean {
  const cfWorker = getHeaderValue(request.headers['cf-worker']);
  return cfWorker != null && cfWorker.toLowerCase().includes('smithery');
}

function getSmitheryPublicUrl(): string | undefined {
  return process.env.MCP_SMITHERY_PUBLIC_URL?.trim();
}

/**
 * Resolves the public base URL for the SSE endpoint event. When the request comes from
 * Smithery proxy (cf-worker header contains "smithery"), uses MCP_SMITHERY_PUBLIC_URL
 * or the first allowed URL with host server.smithery.ai. Otherwise uses Host or
 * X-Forwarded-Host to pick the matching allowed URL.
 * @param request - Fastify request (GET /sse)
 * @param allowedUrls - List of allowed base URLs (e.g. from MCP_PUBLIC_URLS)
 * @returns The base URL to advertise in the endpoint event, or undefined if list is empty
 */
export function resolvePublicBaseUrlForRequest(
  request: FastifyRequest,
  allowedUrls: string[]
): string | undefined {
  if (allowedUrls.length === 0) return undefined;

  if (isSmitheryProxyRequest(request)) {
    const smitheryUrl = getSmitheryPublicUrl();
    if (smitheryUrl) return smitheryUrl;
    for (const url of allowedUrls) {
      try {
        const u = new URL(url);
        if (u.hostname.toLowerCase() === SMITHERY_HOST) return url;
      } catch {
        // skip invalid URLs
      }
    }
    return allowedUrls[0];
  }

  const forwardedHost = getHeaderValue(request.headers['x-forwarded-host']);
  const hostHeader = getHeaderValue(request.headers.host);
  const effectiveHostRaw = forwardedHost || hostHeader;
  if (!effectiveHostRaw) return allowedUrls[0];

  const effectiveHost = effectiveHostRaw.split(':')[0].toLowerCase().trim();

  for (const url of allowedUrls) {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() === effectiveHost) return url;
    } catch {
      // skip invalid URLs
    }
  }

  return allowedUrls[0];
}

/**
 * Session configuration JSON Schema for MCP discovery (e.g. Smithery).
 * All fields optional. Uses x-from (non-reserved header) and x-to so gateway sends Bearer token as Authorization.
 */
export const MCP_SESSION_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/samson-art/transcriptor-mcp#mcp-config',
  title: 'Transcriptor MCP configuration',
  description:
    'Optional session configuration. No fields are required. When connecting via Smithery, set authToken in config; the gateway forwards it as Authorization to the server.',
  type: 'object',
  properties: {
    authToken: {
      type: 'string',
      title: 'Bearer token',
      description:
        'Auth token for protected servers. Only needed when the server uses MCP_AUTH_TOKEN. Stored locally by your client; never logged or shared.',
      secret: true,
      'x-from': { header: 'x-mcp-auth-token' },
      'x-to': { header: 'Authorization' },
    },
  },
  required: [] as string[],
  additionalProperties: false,
} as const;

/** Static MCP server card for discovery (e.g. Smithery) at /.well-known/mcp/server-card.json */
function getServerCard(): {
  serverInfo: { name: string; version: string };
  authentication: { required: boolean; schemes: string[] };
  configSchema: typeof MCP_SESSION_CONFIG_SCHEMA;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; idempotentHint: boolean };
  }>;
  resources: unknown[];
  prompts: unknown[];
} {
  return {
    serverInfo: { name: 'transcriptor-mcp', version },
    authentication: {
      required: !!authToken,
      schemes: authToken ? ['bearer'] : [],
    },
    configSchema: MCP_SESSION_CONFIG_SCHEMA,
    tools: [
      {
        name: 'get_transcript',
        description:
          'Fetch cleaned subtitles as plain text for a video (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion). Input: URL only. Uses auto-discovery for type/language and returns the first chunk with default size.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Video URL or YouTube video ID' } },
          required: ['url'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'get_raw_subtitles',
        description:
          'Fetch raw SRT/VTT subtitles for a video (supported platforms). Optional lang: when omitted and Whisper fallback is used, language is auto-detected.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Video URL or YouTube video ID' },
            type: { type: 'string', enum: ['official', 'auto'] },
            lang: { type: 'string' },
            response_limit: { type: 'integer' },
            next_cursor: { type: 'string' },
          },
          required: ['url'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'get_available_subtitles',
        description: 'List available official and auto-generated subtitle languages.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Video URL or YouTube video ID' } },
          required: ['url'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'get_video_info',
        description:
          'Fetch extended metadata for a video (title, channel, duration, tags, thumbnails, etc.).',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Video URL or YouTube video ID' } },
          required: ['url'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'get_video_chapters',
        description: 'Fetch chapter markers (start/end time, title) for a video.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Video URL or YouTube video ID' } },
          required: ['url'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: 'search_videos',
        description:
          'Search videos on YouTube via yt-dlp (ytsearch). Returns list of matching videos with metadata. Optional: limit, offset (pagination), uploadDateFilter (hour|today|week|month|year), response_format (json|markdown).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'integer', description: 'Max results (default 10, max 50)' },
            offset: { type: 'integer', description: 'Skip first N results (pagination)' },
            uploadDateFilter: {
              type: 'string',
              enum: ['hour', 'today', 'week', 'month', 'year'],
              description: 'Filter by upload date (relative to now)',
            },
            response_format: {
              type: 'string',
              enum: ['json', 'markdown'],
              description: 'Format of human-readable content: json (default) or markdown',
            },
          },
          required: [],
        },
        annotations: { readOnlyHint: true, idempotentHint: false },
      },
    ],
    resources: [
      {
        name: 'supported-platforms',
        uri: 'transcriptor://docs/supported-platforms',
        description: 'List of supported video platforms for subtitles and transcripts',
        mimeType: 'text/plain',
      },
      {
        name: 'usage',
        uri: 'transcriptor://docs/usage',
        description: 'Brief usage guide for transcriptor-mcp tools',
        mimeType: 'text/plain',
      },
    ],
    prompts: [
      {
        name: 'get_transcript_for_video',
        description:
          'Build a user message that asks the model to fetch the video transcript using the get_transcript tool.',
        arguments: [
          {
            name: 'url',
            description: 'Video URL or YouTube video ID',
            required: true,
          },
        ],
      },
      {
        name: 'summarize_video',
        description:
          'Build a user message that asks the model to fetch the transcript and summarize the video content.',
        arguments: [
          {
            name: 'url',
            description: 'Video URL or YouTube video ID',
            required: true,
          },
        ],
      },
    ],
  };
}

const SESSION_TTL_MS = process.env.MCP_SESSION_TTL_MS
  ? Number.parseInt(process.env.MCP_SESSION_TTL_MS, 10)
  : 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = process.env.MCP_SESSION_CLEANUP_INTERVAL_MS
  ? Number.parseInt(process.env.MCP_SESSION_CLEANUP_INTERVAL_MS, 10)
  : 15 * 60 * 1000; // 15 minutes

app.register(rateLimit, {
  max: process.env.MCP_RATE_LIMIT_MAX ? Number.parseInt(process.env.MCP_RATE_LIMIT_MAX, 10) : 100,
  timeWindow: process.env.MCP_RATE_LIMIT_TIME_WINDOW || '1 minute',
});

app.get('/health', async (_request, reply) => {
  return reply.code(200).send({ status: 'ok' });
});

// MCP server discovery (e.g. Smithery) — no auth so scanners can read metadata
app.get('/.well-known/mcp/server-card.json', async (_request, reply) => {
  return reply.code(200).type('application/json').send(getServerCard());
});

app.get('/.well-known/mcp/config-schema.json', async (_request, reply) => {
  return reply.code(200).type('application/json').send(MCP_SESSION_CONFIG_SCHEMA);
});

app.get('/metrics', async (_request, reply) => {
  const metrics = await renderPrometheus();
  return reply.header('Content-Type', 'text/plain; charset=utf-8').send(metrics);
});

app.get('/failures', async (_request, reply) => {
  return reply.code(200).send(getFailedSubtitlesUrls());
});

function updateMcpSessionGauges(): void {
  setMcpSessionCount('streamable', streamableSessions.size);
  setMcpSessionCount('sse', sseSessions.size);
}

async function handleStreamablePost(
  request: FastifyRequest<{ Body?: unknown }>,
  reply: FastifyReply
): Promise<void> {
  const body = request.body;
  const sessionId = getHeaderValue(request.headers['mcp-session-id']);

  if (sessionId) {
    const session = streamableSessions.get(sessionId);
    if (!session) {
      reply.raw.statusCode = 404;
      reply.raw.end('Unknown session');
      return;
    }
    await session.transport.handleRequest(request.raw, reply.raw, body);
    return;
  }

  if (isInitializeRequest(body)) {
    const server = createMcpServer({ logger: app.log });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        streamableSessions.set(id, { server, transport, createdAt: Date.now() });
        updateMcpSessionGauges();
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        streamableSessions.delete(id);
        updateMcpSessionGauges();
      }
    };

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, body);
    return;
  }

  reply.raw.statusCode = 400;
  reply.raw.end('Bad Request: No valid session ID provided');
}

async function handleStreamableGetOrDelete(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) {
    reply.raw.statusCode = 400;
    reply.raw.end('Invalid or missing session ID');
    return;
  }

  const session = streamableSessions.get(sessionId);
  if (!session) {
    reply.raw.statusCode = 404;
    reply.raw.end('Unknown session');
    return;
  }

  await session.transport.handleRequest(request.raw, reply.raw);
}

app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  handler: async (request, reply) => {
    if (!ensureAuth(request, reply, authToken)) {
      return;
    }

    reply.hijack();
    const sessionId = getHeaderValue(request.headers['mcp-session-id']);

    if (request.method === 'POST') {
      await handleStreamablePost(request, reply);
      return;
    }

    await handleStreamableGetOrDelete(request, reply, sessionId);
  },
});

/** POST /sse compatibility: some MCP clients (e.g. Cursor via Smithery) POST to /sse for streamable HTTP.
 * Delegate to streamable handler; correct endpoint is POST /mcp. */
app.post('/sse', async (request, reply) => {
  if (!ensureAuth(request, reply, authToken)) {
    return;
  }

  reply.hijack();
  await handleStreamablePost(request, reply);
});

app.get('/sse', async (request, reply) => {
  if (!ensureAuth(request, reply, authToken)) {
    return;
  }

  reply.hijack();
  const server = createMcpServer({ logger: app.log });
  const sseOptions = getSseOptions();
  const resolvedUrl = resolvePublicBaseUrlForRequest(request, mcpPublicUrls);
  const transport = createSseTransport('/message', reply.raw, sseOptions, resolvedUrl);

  transport.onclose = () => {
    sseSessions.delete(transport.sessionId);
    updateMcpSessionGauges();
  };
  transport.onerror = (error) => {
    app.log.error({ error }, 'SSE transport error');
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  };

  await server.connect(transport);
  sseSessions.set(transport.sessionId, { server, transport, createdAt: Date.now() });
  updateMcpSessionGauges();
});

app.post('/message', async (request, reply) => {
  if (!ensureAuth(request, reply, authToken)) {
    return;
  }

  const query = request.query as { sessionId?: string };
  const sessionId = query?.sessionId;
  if (!sessionId) {
    reply.code(400).send({ error: 'Missing sessionId' });
    return;
  }

  const session = sseSessions.get(sessionId);
  if (!session) {
    reply.code(404).send({ error: 'Unknown session' });
    return;
  }

  reply.hijack();
  await session.transport.handlePostMessage(request.raw, reply.raw, request.body);
});

/**
 * Removes sessions older than TTL. Exported for testing.
 * @param overrideTtlMs - optional TTL override for tests (default: SESSION_TTL_MS)
 */
export function cleanupExpiredSessions(overrideTtlMs?: number): void {
  const ttl = overrideTtlMs ?? SESSION_TTL_MS;
  const now = Date.now();
  for (const [id, session] of streamableSessions.entries()) {
    if (now - session.createdAt > ttl) {
      streamableSessions.delete(id);
      app.log.debug({ sessionId: id }, 'Removed expired streamable session');
    }
  }
  for (const [id, session] of sseSessions.entries()) {
    if (now - session.createdAt > ttl) {
      sseSessions.delete(id);
      app.log.debug({ sessionId: id }, 'Removed expired SSE session');
    }
  }
}

async function start() {
  try {
    await checkYtDlpAtStartup({
      error: (msg) => app.log.error(msg),
      warn: (msg) => app.log.warn(msg),
    });
    await app.listen({ port: mcpPort, host: mcpHost });
    app.log.info(`MCP HTTP server listening on ${mcpHost}:${mcpPort}`);

    const cleanupInterval = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
    cleanupInterval.unref();
  } catch (error) {
    app.log.error(error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  }
}

const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = process.env.SHUTDOWN_TIMEOUT
    ? Number.parseInt(process.env.SHUTDOWN_TIMEOUT, 10)
    : 10000;

  const forceShutdownTimer = setTimeout(() => {
    app.log.warn('Shutdown timeout reached, forcing exit...');
    process.exit(1);
  }, shutdownTimeout);

  try {
    await app.close();
    await closeCache();
    clearTimeout(forceShutdownTimer);
    app.log.info('MCP HTTP server closed successfully');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceShutdownTimer);
    const error = err instanceof Error ? err : new Error(String(err));
    app.log.error(error, 'Error during shutdown');
    Sentry.captureException(error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  app.log.error(error, 'Unhandled Rejection');
  Sentry.captureException(error);
});

process.on('uncaughtException', (error) => {
  app.log.error(error, 'Uncaught Exception');
  Sentry.captureException(error);
  void shutdown('uncaughtException');
});

function isInitializeRequest(body: unknown): body is { method: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }

  return (body as { method?: unknown }).method === 'initialize';
}

function parseEnvList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length ? entries : undefined;
}

function getSseOptions(): SSEServerTransportOptions | undefined {
  const allowedHosts = parseEnvList(process.env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseEnvList(process.env.MCP_ALLOWED_ORIGINS);

  if (!allowedHosts && !allowedOrigins) {
    return undefined;
  }

  return {
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
  };
}

/** Session maps exported for testing */
export { streamableSessions, sseSessions };

/** App exported for testing */
export { app };

// Skip start when running under Jest (tests use app.inject())
if (!process.env.JEST_WORKER_ID) {
  void start();
}
