import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
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

// Response schemas for OpenAPI/Swagger
const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
});

const SubtitlesResponseSchema = Type.Object({
  videoId: Type.String(),
  type: Type.Union([Type.Literal('official'), Type.Literal('auto')]),
  lang: Type.String(),
  text: Type.String(),
  length: Type.Number(),
});

const RawSubtitlesResponseSchema = Type.Object({
  videoId: Type.String(),
  type: Type.Union([Type.Literal('official'), Type.Literal('auto')]),
  lang: Type.String(),
  format: Type.String(),
  content: Type.String(),
  length: Type.Number(),
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

const API_VERSION = '0.3.5';

const fastify = Fastify({
  logger: true,
}).withTypeProvider<TypeBoxTypeProvider>();

// Register CORS
fastify.register(cors, {
  origin: true,
});

// Register rate limiting
fastify.register(rateLimit, {
  max: process.env.RATE_LIMIT_MAX ? Number.parseInt(process.env.RATE_LIMIT_MAX, 10) : 100, // maximum number of requests
  timeWindow: process.env.RATE_LIMIT_TIME_WINDOW || '1 minute', // time window
});

// Register Swagger and API routes in the same context so OpenAPI discovers the routes
fastify.register(async (instance) => {
  instance.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'YT Captions API',
        description: 'API for downloading subtitles from YouTube videos',
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
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as GetSubtitlesRequest;

        const result = await validateAndDownloadSubtitles(body, reply, instance.log);
        if (!result) {
          return; // Response already sent from validateAndDownloadSubtitles
        }

        const { videoId, type, lang, subtitlesContent } = result;

        // Parse and clean subtitles
        let plainText: string;
        try {
          plainText = parseSubtitles(subtitlesContent, instance.log);
        } catch (error) {
          instance.log.error(error);
          return reply.code(500).send({
            error: 'Parsing error',
            message: error instanceof Error ? error.message : 'Failed to parse subtitles',
          });
        }

        return reply.send({
          videoId,
          type,
          lang,
          text: plainText,
          length: plainText.length,
        });
      } catch (error) {
        instance.log.error(error);
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
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
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as GetSubtitlesRequest;

        const result = await validateAndDownloadSubtitles(body, reply, instance.log);
        if (!result) {
          return; // Response already sent from validateAndDownloadSubtitles
        }

        const { videoId, type, lang, subtitlesContent } = result;

        // Detect subtitle format
        const format = detectSubtitleFormat(subtitlesContent);

        return reply.send({
          videoId,
          type,
          lang,
          format,
          content: subtitlesContent,
          length: subtitlesContent.length,
        });
      } catch (error) {
        instance.log.error(error);
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
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
      try {
        const body = request.body as GetAvailableSubtitlesRequest;

        const result = await validateAndFetchAvailableSubtitles(body, reply, instance.log);
        if (!result) {
          return; // Response already sent from validateAndFetchAvailableSubtitles
        }

        const { videoId, official, auto } = result;

        return reply.send({
          videoId,
          official,
          auto,
        });
      } catch (error) {
        instance.log.error(error);
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
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
      try {
        const body = request.body as GetVideoInfoRequest;

        const result = await validateAndFetchVideoInfo(body, reply, instance.log);
        if (!result) {
          return;
        }

        const { videoId, info } = result;

        return reply.send({
          videoId,
          ...info,
        });
      } catch (error) {
        instance.log.error(error);
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
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
      try {
        const body = request.body as GetVideoInfoRequest;

        const result = await validateAndFetchVideoChapters(body, reply, instance.log);
        if (!result) {
          return;
        }

        const { videoId, chapters } = result;

        return reply.send({
          videoId,
          chapters,
        });
      } catch (error) {
        instance.log.error(error);
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
    }
  );
});

const start = async () => {
  try {
    const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = process.env.SHUTDOWN_TIMEOUT
    ? Number.parseInt(process.env.SHUTDOWN_TIMEOUT, 10)
    : 10000; // 10 seconds default

  // Timer for forced termination if shutdown takes too long
  const forceShutdownTimer = setTimeout(() => {
    fastify.log.warn('Shutdown timeout reached, forcing exit...');
    process.exit(1);
  }, shutdownTimeout);

  try {
    // Stop accepting new requests and wait for current ones to complete
    // Fastify automatically waits for active requests to complete
    await fastify.close();
    clearTimeout(forceShutdownTimer);
    fastify.log.info('Server closed successfully');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceShutdownTimer);
    const error = err instanceof Error ? err : new Error(String(err));
    fastify.log.error(error, 'Error during shutdown');
    process.exit(1);
  }
};

// Handle termination signals
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

// Handle unhandled errors
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  fastify.log.error(error, 'Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
  fastify.log.error(error, 'Uncaught Exception');
  void shutdown('uncaughtException');
});

void start();
