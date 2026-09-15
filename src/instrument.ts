/**
 * Sentry instrumentation. Must be loaded first via node -r ./dist/instrument.js
 * so that error and performance instrumentation is applied before other modules.
 * When SENTRY_DSN is not set, the SDK does not send events.
 */
import * as Sentry from '@sentry/node';
import { HttpError, YtDlpError } from './errors.js';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
  maxBreadcrumbs: 100,
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 0.1,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true',
  beforeSend(event, hint) {
    const ex = hint.originalException;
    // 4xx means "this request/video", not "this server": noise, not a fault.
    if (ex instanceof HttpError && ex.statusCode < 500) {
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
