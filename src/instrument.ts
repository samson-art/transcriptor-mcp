/**
 * Sentry instrumentation. Must be loaded first via node -r ./dist/instrument.js
 * so that error and performance instrumentation is applied before other modules.
 * When SENTRY_DSN is not set, the SDK does not send events.
 */
import * as Sentry from '@sentry/node';
import { HttpError, ServerBusyError, YtDlpError } from './errors.js';
import { version } from './version.js';

/** Span attributes that hold a request header or an IP outside `http.request.header.*`. */
const HEADER_SPAN_KEYS = new Set([
  'http.client_ip',
  'http.user_agent',
  'net.peer.ip',
  'net.peer.port',
]);

/** MCP clients by user agent. The first match wins, so Codex comes before OpenAI. */
const CLIENT_FAMILIES: Array<[family: string, userAgent: RegExp]> = [
  ['codex', /codex/i],
  ['openai', /openai/i],
  ['claude', /claude/i],
  ['cursor', /cursor/i],
  ['opencode', /opencode/i],
  ['google', /google|gemini/i],
];

/** A fixed name for the client, which names no person, in place of its user agent. */
function clientFamily(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string' || userAgent === '') return undefined;
  return CLIENT_FAMILIES.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? 'other';
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  // Without this every deploy lands in Sentry as the same release.
  release: process.env.SENTRY_RELEASE || version,
  maxBreadcrumbs: 100,
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 0.1,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
  // For the log per tool call of a known user (#118). Nothing else calls Sentry.logger.
  enableLogs: true,
  integrations: [
    // With tracing on, this integration sends a route's error before the app's error handler
    // runs, without the handler's `route` tag and `requestUrl`. The handler's own capture of
    // the same error is then dropped as a duplicate. The REST and MCP HTTP error handlers
    // capture every 5xx themselves, so the integration only traces.
    Sentry.fastifyIntegration({ shouldHandleError: () => false }),
    // The SDK attaches every request header and up to 10 KB of the request body to an event
    // by default. Behind the gateway the headers include the user id (x-mcpal-user-id), and
    // the body holds the tool arguments. The privacy policy says neither goes to Sentry, and
    // no IP either. `ip` is set here, so SENTRY_SEND_DEFAULT_PII cannot turn it on.
    Sentry.requestDataIntegration({
      include: { headers: false, data: false, cookies: false, ip: false },
    }),
  ],
  beforeSend(event, hint) {
    const ex = hint.originalException;
    // 4xx means "this request/video", not "this server": noise, not a fault.
    // Load shedding is expected under a burst; the metrics show it.
    // A caption hold answers without a run, and the 429 that started it was already sent:
    // 50 calls during one hold sent 50 events and can use up the quota.
    if (
      (ex instanceof HttpError && ex.statusCode < 500) ||
      ex instanceof ServerBusyError ||
      (ex instanceof YtDlpError && ex.held)
    ) {
      return null;
    }
    // One issue per failure class, whichever tool or call site raised it.
    if (ex instanceof YtDlpError) {
      event.fingerprint = ['yt-dlp', ex.reason];
      event.tags = { ...event.tags, yt_dlp_reason: ex.reason };
    }
    return event;
  },
  // The HTTP span of a sampled request copies every request header and the caller's IP into
  // its attributes, whatever requestDataIntegration says. The privacy policy says neither goes
  // to Sentry, so they leave each span here. The SDK runs this on the root span of a
  // transaction too. Two facts from the headers stay, as fixed values: the MCP protocol
  // version and the client family. They show which clients and versions call the server.
  beforeSendSpan(span) {
    const { data } = span;
    if (span.op === 'http.server') {
      const version = data['http.request.header.mcp_protocol_version'];
      if (typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version)) {
        data['mcp.protocol.version'] = version;
      }
      const family = clientFamily(data['http.user_agent']);
      if (family) data['mcp.client.family'] = family;
    }
    for (const key of Object.keys(data)) {
      if (key.startsWith('http.request.header.') || HEADER_SPAN_KEYS.has(key)) delete data[key];
    }
    return span;
  },
});
