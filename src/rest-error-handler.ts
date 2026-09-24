import type { FastifyBaseLogger, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import * as Sentry from '@sentry/node';
import { HttpError, httpErrorAnswer, NotFoundError, ServerBusyError } from './errors.js';
import { recordExpected404 } from './metrics.js';

/** 'Too Many Requests' → 'Too many requests', like our own labels ('Bad request'). */
const sentenceCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** The REST API's error handler. Its own module so tests can mount it without starting the server. */
export function restErrorHandler(
  this: { log: FastifyBaseLogger },
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { statusCode, message } = httpErrorAnswer(error);
  const errorLabel =
    error instanceof HttpError
      ? error.errorLabel
      : statusCode >= 500
        ? 'Internal server error'
        : sentenceCase(STATUS_CODES[statusCode] ?? 'Bad request');
  const route = request.routeOptions?.url ?? request.url?.split('?')[0] ?? 'unknown';

  // Load shedding is a known state under a burst, not a fault to page on.
  if (statusCode >= 500 && !(error instanceof ServerBusyError)) {
    this.log.error(error);
  } else {
    this.log.warn({ err: error }, error.message);
  }

  // Every 404 here is planned: NotFoundError, or a per-video yt-dlp class (private, removed).
  if (statusCode === 404) {
    recordExpected404(request.method, route);
  }

  // Fastify's own 4xx (a bad body, the rate limit) are the caller's doing: under a burst,
  // one event per rejected request would spend the Sentry quota the limit protects.
  if (statusCode >= 500 || error instanceof HttpError) {
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
  }

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
