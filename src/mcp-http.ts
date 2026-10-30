/**
 * MCP over Streamable HTTP, served natively by this process (no mcp-proxy sidecar).
 *
 * Runs in the SDK's stateless mode: no `Mcp-Session-Id` is issued and no state is kept
 * between requests, so any instance can answer any request. Authentication is NOT handled
 * here — the deployment terminates OAuth at the gateway in front of this listener.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as Sentry from '@sentry/node';
import { httpErrorAnswer, ORIGIN_NOT_ALLOWED_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from './errors.js';
import { createMcpServer } from './mcp-core.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';
import { renderPrometheus } from './metrics.js';
import { parseIntEnv } from './env.js';
import { setupLifecycle } from './lifecycle.js';
import { checkYtDlpAtStartup, checkYtDlpVersion } from './yt-dlp-check.js';
import { startCanary } from './canary.js';
import { close as closeCache } from './cache.js';

/** Canonical Streamable HTTP endpoint. Clients POST JSON-RPC here. */
export const MCP_PATH = '/mcp';

export const DEFAULT_MCP_PORT = 4200;
export const DEFAULT_MCP_HOST = '0.0.0.0';

// JSON-RPC error codes (https://www.jsonrpc.org/specification + MCP reserved range)
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_SERVER_ERROR = -32000;

/** Fastify body-parser failures that map to a JSON-RPC parse error. */
const PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

type JsonRpcErrorBody = {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
};

/**
 * Every error on the MCP endpoint must be a valid JSON-RPC envelope: clients use the
 * response body (not just the status) to tell an MCP server apart from an unrelated one.
 */
function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** A DNS rebinding page never has a loopback origin, so these pass when no list is set. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Null for `Origin: null` (a sandboxed page, a file, a no-referrer page) and other non-URLs. */
function parseOrigin(origin: string): URL | null {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

/**
 * Read on each request. Full origins, comma separated, matched exactly, the way the REST API
 * reads CORS_ALLOWED_ORIGINS. A list replaces the loopback default, and `*` allows all origins.
 */
function isAllowedOrigin(origin: string): boolean {
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.length > 0) return allowed.includes('*') || allowed.includes(origin);
  const url = parseOrigin(origin);
  return (
    url !== null &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOOPBACK_HOSTNAMES.has(url.hostname)
  );
}

/**
 * The Origin rule of the MCP spec (#82, ADR 001). On 2026-10-07 a local 1.5.21 build answered
 * tools/list with `Origin: https://example.com` with 200. A browser sends Origin with every
 * POST. So a page that points its own domain name at this listener (DNS rebinding) gets 403
 * here, before a server or a transport exists. Clients outside a browser send no Origin and
 * pass. This is a route hook and not the SDK option: SDK 1.30 marks that option deprecated,
 * and SDK 2.x does not have it.
 *
 * ponytail: only POST, GET and DELETE carry the hook (HEAD copies it from GET). PUT, PATCH and
 * OPTIONS on /mcp keep the 404 of the not-found handler for every Origin, and no tool runs
 * there. Give them the hook if a client ever needs a 403 for them.
 */
async function refuseForeignOrigin(request: FastifyRequest, reply: FastifyReply) {
  const { origin } = request.headers;
  // Empty counts as absent: a browser never sends it, and the deprecated SDK rule skips it too.
  if (!origin || isAllowedOrigin(origin)) return;
  // `originHost` and not `hostname`: pino already puts the machine name in that field.
  request.log.warn(
    { originHost: parseOrigin(origin)?.hostname ?? null },
    'Refused a request to /mcp with an Origin that MCP_ALLOWED_ORIGINS does not allow'
  );
  return reply.code(403).send(jsonRpcError(JSONRPC_SERVER_ERROR, ORIGIN_NOT_ALLOWED_MESSAGE));
}

export type BuildMcpHttpAppOptions = {
  /** Logger to use instead of the default (tests pass a silent one). */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
};

/**
 * Builds the MCP HTTP app without listening. Exported so tests can drive it directly.
 */
export function buildMcpHttpApp(opts?: BuildMcpHttpAppOptions): FastifyInstance {
  const app: FastifyInstance = Fastify({
    loggerInstance: opts?.loggerInstance ?? createLoggerWithSentryBreadcrumbs(),
    // Adopt the gateway's request id so its logs, ours and Sentry share one key.
    // Safe only because this port is reachable from the gateway alone and the
    // gateway overwrites the header; never expose this listener publicly.
    requestIdHeader: 'x-request-id',
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const { statusCode, message } = httpErrorAnswer(error);
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'MCP HTTP request failed');
      Sentry.captureException(error);
    } else {
      request.log.warn({ err: error }, error.message);
    }

    let code = JSONRPC_SERVER_ERROR;
    if (PARSE_ERROR_CODES.has(error.code)) {
      code = JSONRPC_PARSE_ERROR;
    } else if (statusCode >= 500) {
      code = JSONRPC_INTERNAL_ERROR;
    }

    return reply.code(statusCode).send(jsonRpcError(code, message));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(jsonRpcError(JSONRPC_METHOD_NOT_FOUND, 'Not found'));
  });

  // Probes, scrapes and 405s would otherwise log two info lines each.
  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
    const metrics = await renderPrometheus();
    return reply.header('Content-Type', 'text/plain; charset=utf-8').send(metrics);
  });

  app.post(MCP_PATH, { onRequest: refuseForeignOrigin }, async (request, reply) => {
    // The transport writes status, headers and body straight to the raw response
    // (including SSE frames), so Fastify must stop managing this reply.
    reply.hijack();

    // Stateless mode requires a fresh transport per request: the SDK throws when one is
    // reused, because concurrent clients would collide on JSON-RPC message ids. The
    // server is per-request for the same reason; tool registration is in-memory only.
    const server = createMcpServer({ logger: request.log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    // Fires on normal completion and on client disconnect; a disconnect mid-call is the
    // client cancelling, so tearing the server down is the intended behavior.
    reply.raw.on('close', dispose);

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err), { cause: err });
      request.log.error({ err: error }, 'MCP HTTP transport failed');
      Sentry.captureException(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify(jsonRpcError(JSONRPC_INTERNAL_ERROR, UNEXPECTED_ERROR_MESSAGE))
        );
      } else {
        reply.raw.end();
      }
      dispose();
    }
  });

  // The transport does NOT reject GET/DELETE in stateless mode — a GET would open an SSE
  // stream that nothing ever writes to and that only closes on disconnect. Answer here.
  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_PATH,
    logLevel: 'warn',
    onRequest: refuseForeignOrigin,
    handler: async (_request, reply) => {
      return reply
        .code(405)
        .header('Allow', 'POST')
        .send(jsonRpcError(JSONRPC_SERVER_ERROR, 'Method not allowed.'));
    },
  });

  return app;
}

/**
 * Builds the app, wires shutdown handling and starts listening.
 * Port/host come from MCP_PORT / MCP_HOST.
 */
export async function startMcpHttpServer(): Promise<FastifyInstance> {
  const app = buildMcpHttpApp();

  setupLifecycle({
    server: app,
    closeCache,
    log: app.log,
    shutdownSuccessMessage: 'MCP HTTP server closed successfully',
  });

  const ytDlpLog = {
    error: (msg: string) => app.log.error(msg),
    warn: (msg: string) => app.log.warn(msg),
  };
  await checkYtDlpAtStartup(ytDlpLog);

  startCanary(app.log);
  // yt-dlp is frozen in the image at build time, so a server that has been up for
  // weeks drifts behind the releases that keep extraction working. Unref'd.
  setInterval(() => void checkYtDlpVersion(ytDlpLog), 24 * 60 * 60 * 1000).unref();

  const port = parseIntEnv('MCP_PORT', DEFAULT_MCP_PORT);
  const host = process.env.MCP_HOST || DEFAULT_MCP_HOST;
  await app.listen({ port, host });
  app.log.info(`MCP Streamable HTTP server listening on ${host}:${port}${MCP_PATH}`);
  return app;
}
