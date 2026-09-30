/**
 * Sentry instrumentation. Must be loaded first via node -r ./dist/instrument.js
 * so that error and performance instrumentation is applied before other modules.
 * When SENTRY_DSN is not set, the SDK does not send events.
 */
import * as Sentry from '@sentry/node';
import { HttpError, ServerBusyError, YtDlpError } from './errors.js';
import { version } from './version.js';

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
  integrations: [
    // With tracing on, this integration sends a route's error before the app's error handler
    // runs, without the handler's `route` tag and `requestUrl`. The handler's own capture of
    // the same error is then dropped as a duplicate. The REST and MCP HTTP error handlers
    // capture every 5xx themselves, so the integration only traces.
    Sentry.fastifyIntegration({ shouldHandleError: () => false }),
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
});
