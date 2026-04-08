# Error monitoring with Sentry

Transcriptor MCP can send errors to [Sentry](https://sentry.io) for grouping, stack traces, and context. This complements Prometheus metrics (see [monitoring.md](monitoring.md)) with detailed error reporting.

## Why Sentry

- **Single place for errors** — 5xx responses, unhandled rejections, uncaught exceptions, and shutdown failures are captured with stack traces.
- **Grouping and context** — Request URL/method are attached for API errors; you can set environment and release for filtering.
- **Alerts** — Configure Sentry Alerts and notifications (email, Slack) for new or recurring issues.

## Sentry Cloud setup

1. Sign up at [sentry.io](https://sentry.io) (free tier available).
2. Create an organization and a project; choose **Node.js** as the platform.
3. In the project settings, copy the **DSN** (e.g. `https://<key>@o0.ingest.sentry.io/<project_id>`).
4. Optionally configure [Alerts](https://docs.sentry.io/product/alerts/) and notification integrations (Slack, email).

## Application configuration

Set these environment variables when running the REST API or MCP HTTP server:

| Variable | Description |
|----------|-------------|
| `SENTRY_DSN` | Your project DSN from Sentry. If unset, the SDK does not send any events (no-op). |
| `SENTRY_ENVIRONMENT` | Optional. e.g. `production`, `staging`. Shown in Sentry for filtering. |
| `SENTRY_RELEASE` | Optional. Set in CI from package.json version or git sha. Helps match errors to deployments. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional. Fraction of transactions sent for Performance (0–1). Default: `0.1`. Use `1` to verify tracing. |
| `SENTRY_SEND_DEFAULT_PII` | Optional. Set to `true` to send default PII (e.g. IP address) with events. |

Example (`.env` or Docker):

```bash
SENTRY_DSN=https://your-key@o0.ingest.sentry.io/your-project-id
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=0.5.0
# SENTRY_TRACES_SAMPLE_RATE=0.1
# SENTRY_SEND_DEFAULT_PII=false
```

When `SENTRY_DSN` is not set, the app runs as before; no events are sent to Sentry.

### Filtering (beforeSend)

The app uses `beforeSend` to skip expected client errors: `NotFoundError` (404) and `ValidationError` (400). These are normal API responses (e.g. subtitles not found) and are monitored via Prometheus instead.

Performance monitoring is active when you run the app via `npm run start` or `start:mcp` (instrument is loaded before other modules). It is not loaded in `dev` / `dev:mcp` scripts.

## Performance / Tracing

Sentry Performance sends **transactions** (e.g. HTTP request duration, spans for outbound calls) so you can see slow endpoints and bottlenecks. The Node SDK auto-instruments HTTP and other modules when `instrument.js` is loaded first.

- **tracesSampleRate** — Controls what fraction of transactions are sent (0–1). Default is `0.1` (10%) to stay within quotas in production. Set `SENTRY_TRACES_SAMPLE_RATE=1` temporarily to verify that transactions appear in Sentry (Performance → Transactions).
- Transactions will appear in Sentry after the first requests to your API (with DSN set and the app started via `start` / `start:mcp`).

## What is captured

- **REST API:** 5xx from the error handler (with request method, URL, statusCode, route tag, and request body URL for subtitle endpoints). Also: startup failures, shutdown errors, unhandled rejections, uncaught exceptions.
- **MCP HTTP:** SSE transport errors (with transport type and sessionId in context), startup failures, shutdown errors, unhandled rejections, uncaught exceptions.

Expected client errors (NotFoundError, ValidationError) are **not** sent to Sentry to reduce noise. They are counted in Prometheus via `http_404_expected_total` and `http_requests_total{status_code="404"}`.

In Sentry you can filter by `request.statusCode`, the `route` tag, or by level to focus on server errors.

## Breadcrumbs

All log calls (debug, info, warn, error) from the Pino logger are added as **breadcrumbs** to Sentry events. When a 4xx or 5xx error is captured, the event includes the full trail of log calls that led up to the error.

To view breadcrumbs in Sentry: open an issue or event → **Breadcrumbs** section shows the chronological sequence of log entries (level, message, data). Breadcrumbs are scoped per request, so you see only the logs for the request that triggered the error.

## Alerts in Sentry

In the Sentry UI: **Alerts** → create a rule (e.g. when an issue is first seen or when event count exceeds a threshold) and add notification actions (email, Slack, etc.). Filter by environment or release if you set `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE`.
