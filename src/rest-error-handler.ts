import type { FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import * as Sentry from '@sentry/node';
import { HttpError, httpErrorAnswer, NotFoundError, ServerBusyError } from './errors.js';
import { recordExpected404 } from './metrics.js';

/** 'Too Many Requests' → 'Too many requests', like our own labels ('Bad request'). */
const sentenceCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** The `route` label of the REST metrics: the route's pattern, or the path when no route matched. */
export const routeOf = (request: FastifyRequest) =>
  request.routeOptions.url ?? request.url.split('?')[0];

/** The REST API's error handler. Its own module so tests can mount it without starting the server. */
export function restErrorHandler(error: Error, request: FastifyRequest, reply: FastifyReply) {
  const { statusCode, message } = httpErrorAnswer(error);
  const errorLabel =
    error instanceof HttpError
      ? error.errorLabel
      : statusCode >= 500
        ? 'Internal server error'
        : sentenceCase(STATUS_CODES[statusCode] ?? 'Bad request');
  const route = routeOf(request);

  // Load shedding is a known state under a burst, not a fault to page on. A 4xx is the
  // caller's doing, and instrument.ts drops our own 4xx before they are sent anyway.
  if (statusCode >= 500 && !(error instanceof ServerBusyError)) {
    request.log.error(error);
    const bodyUrl = (request.body as { url?: unknown } | null | undefined)?.url;
    Sentry.withScope((scope) => {
      scope.setContext('request', {
        method: request.method,
        url: request.url,
        statusCode,
        ...(typeof bodyUrl === 'string' && { requestUrl: bodyUrl }),
      });
      scope.setTag('route', route);
      Sentry.captureException(error);
    });
  } else {
    request.log.warn({ err: error }, error.message);
  }

  // Our own 404s are planned: NotFoundError, or a per-video yt-dlp class (private, removed).
  // A 404 from anywhere else is not.
  if (statusCode === 404 && error instanceof HttpError) {
    recordExpected404(request.method, route);
  }

  const { official, auto } = (error instanceof NotFoundError && error.details) || {};
  const available = { ...(official && { official }), ...(auto && { auto }) };
  return reply
    .code(statusCode)
    .send({ error: errorLabel, message, ...((official || auto) && { available }) });
}
