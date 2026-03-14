import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError, NotFoundError } from './errors.js';
import { parseSubtitles, detectSubtitleFormat } from './youtube.js';
import {
  GetAvailableSubtitlesRequest,
  GetAvailableSubtitlesRequestSchema,
  GetSubtitlesRequest,
  GetSubtitlesRequestSchema,
  GetVideoInfoRequest,
  GetVideoInfoRequestSchema,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
} from './validation.js';
import { version as API_VERSION } from './version.js';
import { checkYtDlpAtStartup } from './yt-dlp-check.js';
import { close as closeCache, ping as cachePing } from './cache.js';
import { setupLifecycle } from './lifecycle.js';
import * as Sentry from '@sentry/node';
import {
  recordRequest,
  recordExpected404,
  renderPrometheus,
  getFailedSubtitlesUrls,
} from './metrics.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';
import { readChangelog } from './changelog.js';
import { parseIntEnv } from './env.js';

// Response schemas for OpenAPI/Swagger
const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
});

const NotFoundResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
  available: Type.Optional(
    Type.Object({
      official: Type.Array(Type.String()),
      auto: Type.Array(Type.String()),
    })
  ),
});

const SubtitlesResponseSchema = Type.Object({
  videoId: Type.String(),
  type: Type.Union([Type.Literal('official'), Type.Literal('auto')]),
  lang: Type.String(),
  text: Type.String(),
  length: Type.Number(),
  source: Type.Optional(Type.String()),
});

const RawSubtitlesResponseSchema = Type.Object({
  videoId: Type.String(),
  type: Type.Union([Type.Literal('official'), Type.Literal('auto')]),
  lang: Type.String(),
  format: Type.String(),
  content: Type.String(),
  length: Type.Number(),
  source: Type.Optional(Type.String()),
});

const AvailableSubtitlesResponseSchema = Type.Object({
  videoId: Type.String(),
  official: Type.Array(Type.String()),
  auto: Type.Array(Type.String()),
});

const VideoInfoResponseSchema = Type.Object({
  videoId: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  duration: Type.Optional(Type.Number()),
  viewCount: Type.Optional(Type.Number()),
  uploadDate: Type.Optional(Type.String()),
  channelId: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
});

const ChapterSchema = Type.Object({
  startTime: Type.Number(),
  endTime: Type.Number(),
  title: Type.String(),
});

const VideoChaptersResponseSchema = Type.Object({
  videoId: Type.String(),
  chapters: Type.Array(ChapterSchema),
});

const fastify = Fastify({
  loggerInstance: createLoggerWithSentryBreadcrumbs(),
}).withTypeProvider<TypeBoxTypeProvider>();

fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'Unknown error occurred';
  const errorLabel = error instanceof HttpError ? error.errorLabel : 'Internal server error';
  const route = request.routeOptions?.url ?? request.url?.split('?')[0] ?? 'unknown';

  if (statusCode >= 500) {
    fastify.log.error(error);
  } else {
    fastify.log.warn({ err: error }, message);
  }

  if (statusCode === 404 && error instanceof NotFoundError) {
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
});

// Register CORS (optional allowlist via CORS_ALLOWED_ORIGINS comma-separated)
const corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.trim()
  ? process.env.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : undefined;
fastify.register(cors, {
  origin: corsAllowedOrigins && corsAllowedOrigins.length > 0 ? corsAllowedOrigins : true,
});

// Register rate limiting
fastify.register(rateLimit, {
  max: parseIntEnv('RATE_LIMIT_MAX', 100), // maximum number of requests
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW || '1 minute', // time window
});

fastify.get('/health', async (_request, reply) => {
  return reply.code(200).send({ status: 'ok' });
});

fastify.get('/health/ready', async (_request, reply) => {
  const redisOk = await cachePing();
  if (!redisOk) {
    return reply.code(503).send({ status: 'not ready', redis: 'unreachable' });
  }
  return reply.code(200).send({ status: 'ready' });
});

// Throw on purpose so Sentry receives a 5xx event (for verifying Sentry integration)
fastify.get('/health/sentry-test', () => {
  throw new Error('Sentry test: this event is expected when verifying error reporting');
});

fastify.get('/metrics', async (_request, reply) => {
  const metrics = await renderPrometheus();
  return reply.header('Content-Type', 'text/plain; charset=utf-8').send(metrics);
});

fastify.get('/failures', async (_request, reply) => {
  return reply.code(200).send(getFailedSubtitlesUrls());
});

fastify.get('/changelogs', async (_request, reply) => {
  const content = await readChangelog();
  return reply.header('Content-Type', 'text/markdown; charset=utf-8').code(200).send(content);
});

const requestStartTimes = new WeakMap<object, number>();
fastify.addHook('onRequest', (request, _reply, done) => {
  requestStartTimes.set(request.raw, Date.now());
  done();
});

fastify.addHook('onResponse', (request, reply, done) => {
  const start = requestStartTimes.get(request.raw);
  if (start !== undefined) {
    const duration = (Date.now() - start) / 1000;
    const method = request.method;
    const route = request.routeOptions?.url ?? request.url?.split('?')[0] ?? 'unknown';
    const statusCode = reply.statusCode;
    recordRequest(method, route, statusCode, duration);
  }
  done();
});

// Register Swagger and API routes in the same context so OpenAPI discovers the routes
fastify.register(async (instance) => {
  instance.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'YT Captions API',
        description:
          'API for downloading subtitles and video metadata from supported platforms (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit)',
        version: API_VERSION,
      },
      servers: [{ url: 'http://localhost:3000', description: 'Development server' }],
    },
  });

  await instance.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
  });

  // Main endpoint
  instance.post(
    '/subtitles',
    {
      schema: {
        description: 'Download and parse subtitles (cleaned plain text)',
        body: GetSubtitlesRequestSchema,
        response: {
          200: SubtitlesResponseSchema,
          400: ErrorResponseSchema,
          404: NotFoundResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GetSubtitlesRequest;

      const result = await validateAndDownloadSubtitles(body, instance.log);
      const { videoId, type, lang, subtitlesContent, source } = result;

      let plainText: string;
      try {
        plainText = parseSubtitles(subtitlesContent, instance.log);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'Failed to parse subtitles', {
          cause: error,
        });
      }

      return reply.send({
        videoId,
        type,
        lang,
        text: plainText,
        length: plainText.length,
        ...(source && { source }),
      });
    }
  );

  // Endpoint for getting raw subtitles without cleaning
  instance.post(
    '/subtitles/raw',
    {
      schema: {
        description: 'Download raw subtitles without cleaning',
        body: GetSubtitlesRequestSchema,
        response: {
          200: RawSubtitlesResponseSchema,
          400: ErrorResponseSchema,
          404: NotFoundResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GetSubtitlesRequest;

      const result = await validateAndDownloadSubtitles(body, instance.log);
      const { videoId, type, lang, subtitlesContent, source } = result;

      const format = detectSubtitleFormat(subtitlesContent);

      return reply.send({
        videoId,
        type,
        lang,
        format,
        content: subtitlesContent,
        length: subtitlesContent.length,
        ...(source && { source }),
      });
    }
  );

  // Endpoint for getting available subtitles (official vs auto) for a video
  instance.post(
    '/subtitles/available',
    {
      schema: {
        description: 'Get list of available subtitle languages (official and auto-generated)',
        body: GetAvailableSubtitlesRequestSchema,
        response: {
          200: AvailableSubtitlesResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GetAvailableSubtitlesRequest;

      const result = await validateAndFetchAvailableSubtitles(body, instance.log);
      const { videoId, official, auto } = result;

      return reply.send({
        videoId,
        official,
        auto,
      });
    }
  );

  // Endpoint for getting extended video info
  instance.post(
    '/video/info',
    {
      schema: {
        description: 'Get extended video metadata',
        body: GetVideoInfoRequestSchema,
        response: {
          200: VideoInfoResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GetVideoInfoRequest;

      const result = await validateAndFetchVideoInfo(body, instance.log);
      const { videoId, info } = result;

      return reply.send({
        videoId,
        ...info,
      });
    }
  );

  // Endpoint for getting video chapters
  instance.post(
    '/video/chapters',
    {
      schema: {
        description: 'Get video chapters',
        body: GetVideoInfoRequestSchema,
        response: {
          200: VideoChaptersResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as GetVideoInfoRequest;

      const result = await validateAndFetchVideoChapters(body, instance.log);
      const { videoId, chapters } = result;

      return reply.send({
        videoId,
        chapters,
      });
    }
  );
});

const start = async () => {
  try {
    await checkYtDlpAtStartup({
      error: (msg) => fastify.log.error(msg),
      warn: (msg) => fastify.log.warn(msg),
    });
    const port = parseIntEnv('PORT', 3000);
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  }
};

setupLifecycle({
  server: fastify,
  closeCache,
  log: fastify.log,
  shutdownSuccessMessage: 'Server closed successfully',
});

void start();
