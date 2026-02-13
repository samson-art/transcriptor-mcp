import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import {
  SSEServerTransport,
  type SSEServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { close as closeCache } from './cache.js';
import { ensureAuth, getHeaderValue } from './mcp-auth.js';
import { createMcpServer } from './mcp-core.js';
import { checkYtDlpAtStartup } from './yt-dlp-check.js';

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

const app = Fastify({ logger: true });

const streamableSessions = new Map<string, StreamableSession>();
const sseSessions = new Map<string, SseSession>();

const mcpPort = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 4200;
const mcpHost = process.env.MCP_HOST || '0.0.0.0';
const authToken = process.env.MCP_AUTH_TOKEN?.trim();

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
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        streamableSessions.delete(id);
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

app.get('/sse', async (request, reply) => {
  if (!ensureAuth(request, reply, authToken)) {
    return;
  }

  reply.hijack();
  const server = createMcpServer({ logger: app.log });
  const sseOptions = getSseOptions();
  const transport = new SSEServerTransport('/message', reply.raw, sseOptions);

  transport.onclose = () => {
    sseSessions.delete(transport.sessionId);
  };
  transport.onerror = (error) => {
    app.log.error({ error }, 'SSE transport error');
  };

  await server.connect(transport);
  sseSessions.set(transport.sessionId, { server, transport, createdAt: Date.now() });
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
});

process.on('uncaughtException', (error) => {
  app.log.error(error, 'Uncaught Exception');
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
