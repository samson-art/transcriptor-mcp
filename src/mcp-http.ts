/**
 * MCP over Streamable HTTP, served natively by this process (no mcp-proxy sidecar).
 *
 * One endpoint serves both protocol eras (#85, ADR 001): 2026-07-28 requests, which carry
 * their version in `_meta`, and 2025 requests, which start with `initialize`. Both are
 * stateless: no `Mcp-Session-Id` is issued and no state is kept between requests, so any
 * instance can answer any request. Authentication is NOT handled here — the deployment
 * terminates OAuth at the gateway in front of this listener.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import * as Sentry from '@sentry/node';
import { httpErrorAnswer, ORIGIN_NOT_ALLOWED_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from './errors.js';
import { createMcpServer } from './mcp-core.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';
import { renderPrometheus } from './metrics.js';
import { parseIntEnv, parseListEnv } from './env.js';
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

type JsonRpcId = string | number | null;

type JsonRpcErrorBody = {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: JsonRpcId;
};

/**
 * Every error on the MCP endpoint must be a valid JSON-RPC envelope: clients use the
 * response body (not just the status) to tell an MCP server apart from an unrelated one.
 */
function jsonRpcError(code: number, message: string, id: JsonRpcId = null): JsonRpcErrorBody {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

/** The id and the method of a single JSON-RPC message, for an error answer and a log line. */
function messageOf(body: unknown): { id: JsonRpcId; method?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { id: null };
  const { id, method } = body as { id?: unknown; method?: unknown };
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    ...(typeof method === 'string' && { method }),
  };
}

/**
 * What the SDK handler needs of the Fastify request that it serves. The handler lives as long
 * as the app, so the server factory and `onerror` read the request from here.
 */
type McpExchange = { log: FastifyBaseLogger; error?: Error };
const exchange = new AsyncLocalStorage<McpExchange>();

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

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * A list entry in the form that a browser sends, so `https://App.example.com:443/` still matches.
 * Null if it is not an http or https origin: `null` (a hostile page can send that too), a bare
 * host, or a value in the quotes that `docker run --env-file` keeps. The host test is here
 * because URL accepts `https://a.example"` and `https://*.a.example`, and no browser sends them.
 * An entry with a path or a query is dropped too: an origin has neither, and keeping only its
 * origin would allow every page of that site without a word to the operator.
 */
function listedOrigin(entry: string): string | null {
  const url = parseOrigin(entry);
  return url !== null &&
    isHttpUrl(url) &&
    /^[a-z0-9.:_[\]-]+$/.test(url.host) &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
    ? url.origin
    : null;
}

/** Read on each request. A list replaces the loopback default, and `*` allows all origins. */
function isAllowedOrigin(url: URL | null): boolean {
  const entries = parseListEnv('MCP_ALLOWED_ORIGINS');
  if (entries.includes('*')) return true;
  if (url === null) return false;
  if (entries.length > 0) return entries.some((entry) => listedOrigin(entry) === url.origin);
  return isHttpUrl(url) && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * A bad value must not take the server down at an automatic deploy, so the server drops the
 * entry and starts. A value with only dropped entries refuses every Origin, because a silent
 * return to the loopback default would hide the mistake. The line has the position of the entry
 * and not its value, because a pasted value can be a secret.
 */
function warnAboutDroppedOrigins(log: FastifyBaseLogger): void {
  const entries = parseListEnv('MCP_ALLOWED_ORIGINS');
  const isKept = (entry: string) => entry === '*' || listedOrigin(entry) !== null;
  const noneKept = !entries.some(isKept);
  entries.forEach((entry, index) => {
    if (isKept(entry)) return;
    log.warn(
      { entryPosition: index + 1 },
      'Dropped an entry of MCP_ALLOWED_ORIGINS that is not an http or https origin (scheme, host, optional port, no quotes)' +
        (noneKept ? '. No entry is left, so the server refuses every Origin' : '')
    );
  });
}

/**
 * The Origin rule of the MCP spec (#82, ADR 001). On 2026-10-07 a local 1.5.21 build answered
 * tools/list with `Origin: https://example.com` with 200. A browser sends Origin with every
 * POST. So a page that points its own domain name at this listener (DNS rebinding) gets 403
 * here, before a server or a transport exists. Clients outside a browser send no Origin and
 * pass. This is a route hook and not the SDK option: SDK 1.x marks that option deprecated
 * (1.30 to 1.32.2, checked 2026-11-28), and SDK 2.x does not have it.
 *
 * ponytail: only POST, GET and DELETE carry the hook (HEAD copies it from GET). PUT, PATCH and
 * OPTIONS on /mcp keep the 404 of the not-found handler for every Origin, and no tool runs
 * there. Give them the hook if a client ever needs a 403 for them.
 */
async function refuseForeignOrigin(request: FastifyRequest, reply: FastifyReply) {
  const { origin } = request.headers;
  // Empty counts as absent: a browser never sends it, and the deprecated SDK rule skips it too.
  if (!origin) return;
  const url = parseOrigin(origin);
  if (isAllowedOrigin(url)) return;
  // `originHost` and not `hostname`: pino already puts the machine name in that field.
  request.log.warn(
    { originHost: url?.hostname ?? null },
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

  warnAboutDroppedOrigins(app.log);

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

  // The SDK builds a new server for each request from this factory, in both eras (ADR 001).
  // The child logger keeps the reqId of the request on the "MCP tool call" line and adds `era`:
  // the share of `legacy` calls says when the 2025 protocol can go.
  const handler = createMcpHandler(
    ({ era }) => createMcpServer({ logger: currentExchange().log.child({ era }) }),
    {
      // The SDK answers a 2026-07-28 request with one JSON body by default, and sends nothing
      // until the result. A proxy with an idle timeout then cuts a long call. 'sse' sends an
      // SSE comment every 15 s from the start, as the 2025 transport does.
      responseMode: 'sse',
      // The SDK reports refusals (4xx) and faults (5xx) here alike. Only the status of the
      // answer tells them apart, so keep the error for the answer to decide.
      onerror: (error) => {
        const current = exchange.getStore();
        if (current) {
          current.error = error;
        } else {
          app.log.error({ err: error }, 'MCP handler failed outside a request');
          Sentry.captureException(error);
        }
      },
    }
  );

  function currentExchange(): McpExchange {
    const current = exchange.getStore();
    if (!current) throw new Error('MCP server factory called outside a request');
    return current;
  }

  const nodeHandler = toNodeHandler({
    fetch: async (request, options) => {
      const current = currentExchange();
      const { id, method } = messageOf(options?.parsedBody);
      let response: Response;
      try {
        response = await handler.fetch(request, options);
      } catch (err) {
        current.error = err instanceof Error ? err : new Error(String(err), { cause: err });
        response = new Response(null, { status: 500 });
      }

      if (response.status >= 500) {
        const error = current.error ?? new Error(`MCP handler answered ${response.status}`);
        current.log.error({ err: error }, 'MCP HTTP request failed');
        Sentry.captureException(error);
        // The SDK text is not ours, and an error message must not reach the caller.
        return Response.json(jsonRpcError(JSONRPC_INTERNAL_ERROR, UNEXPECTED_ERROR_MESSAGE, id), {
          status: 500,
        });
      }
      if (response.status >= 400) {
        const answer = (await response
          .clone()
          .json()
          .catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
        current.log.warn(
          {
            status: response.status,
            rpcCode: answer?.error?.code,
            rpcMethod: method,
            protocolVersion: request.headers.get('mcp-protocol-version') ?? undefined,
          },
          'Refused an MCP request'
        );
      }
      return response;
    },
  });

  // preClose and not onClose: Fastify waits for open connections before onClose, and an open
  // 2026-07-28 stream would hold the shutdown until SHUTDOWN_TIMEOUT.
  app.addHook('preClose', async () => {
    await handler.close();
  });

  app.post(MCP_PATH, { onRequest: refuseForeignOrigin }, async (request, reply) => {
    // The handler writes status, headers and body straight to the raw response
    // (including SSE frames), so Fastify must stop managing this reply.
    reply.hijack();
    await exchange.run({ log: request.log }, () =>
      nodeHandler(request.raw, reply.raw, request.body)
    );
  });

  // Here and not in the SDK handler: the Origin hook and the log level of this route stay.
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
