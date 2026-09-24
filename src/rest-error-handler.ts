import type { FastifyBaseLogger, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import * as Sentry from '@sentry/node';
import { HttpError, NotFoundError, ServerBusyError } from './errors.js';
import { recordExpected404 } from './metrics.js';

/** The REST API's error handler. Its own module so tests can mount it without starting the server. */
export function restErrorHandler(
  this: { log: FastifyBaseLogger },
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'Unknown error occurred';
  const errorLabel = error instanceof HttpError ? error.errorLabel : 'Internal server error';
  const route = request.routeOptions?.url ?? request.url?.split('?')[0] ?? 'unknown';

  // Load shedding is a known state under a burst, not a fault to page on.
  if (statusCode >= 500 && !(error instanceof ServerBusyError)) {
    this.log.error(error);
  } else {
    this.log.warn({ err: error }, message);
  }

  // Every 404 here is planned: NotFoundError, or a per-video yt-dlp class (private, removed).
  if (statusCode === 404) {
    recordExpected404(request.method, route);
  }

  Sentry.withScope((scope) => {
    const requestContext: Record<string, unknown> = {
      method: request.method,
      url: request.url,
      statusCode,
    };
    if (
      statusCode >= 500 &&
      request.body &&
      typeof request.body === 'object' &&
      'url' in request.body &&
      typeof (request.body as { url?: unknown }).url === 'string'
    ) {
      requestContext.requestUrl = (request.body as { url: string }).url;
    }
    scope.setContext('request', requestContext);
    scope.setTag('route', route);
    if (statusCode >= 400 && statusCode < 500) {
      scope.setLevel('warning');
    }
    Sentry.captureException(error);
  });

  const payload: {
    error: string;
    message: string;
    available?: { official?: string[]; auto?: string[] };
  } = { error: errorLabel, message };
  if (statusCode === 404 && error instanceof NotFoundError && error.details) {
    payload.available = {
      ...(error.details.official && { official: error.details.official }),
      ...(error.details.auto && { auto: error.details.auto }),
    };
    if (Object.keys(payload.available).length === 0) delete payload.available;
  }
  return reply.code(statusCode).send(payload);
}
