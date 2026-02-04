import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { parseSubtitles, detectSubtitleFormat } from './youtube.js';
import {
  GetAvailableSubtitlesRequest,
  GetSubtitlesRequest,
  GetVideoInfoRequest,
  validateAndDownloadSubtitles,
  validateAndFetchAvailableSubtitles,
  validateAndFetchVideoInfo,
  validateAndFetchVideoChapters,
} from './validation.js';

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

// Main endpoint
fastify.post('/subtitles', async (request, reply) => {
  try {
    const body = request.body as GetSubtitlesRequest;

    const result = await validateAndDownloadSubtitles(body, reply, fastify.log);
    if (!result) {
      return; // Response already sent from validateAndDownloadSubtitles
    }

    const { videoId, type, lang, subtitlesContent } = result;

    // Parse and clean subtitles
    let plainText: string;
    try {
      plainText = parseSubtitles(subtitlesContent, fastify.log);
    } catch (error) {
      fastify.log.error(error);
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
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Endpoint for getting raw subtitles without cleaning
fastify.post('/subtitles/raw', async (request, reply) => {
  try {
    const body = request.body as GetSubtitlesRequest;

    const result = await validateAndDownloadSubtitles(body, reply, fastify.log);
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
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Endpoint for getting available subtitles (official vs auto) for a video
fastify.post('/subtitles/available', async (request, reply) => {
  try {
    const body = request.body as GetAvailableSubtitlesRequest;

    const result = await validateAndFetchAvailableSubtitles(body, reply, fastify.log);
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
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Endpoint for getting extended video info
fastify.post('/video/info', async (request, reply) => {
  try {
    const body = request.body as GetVideoInfoRequest;

    const result = await validateAndFetchVideoInfo(body, reply, fastify.log);
    if (!result) {
      return;
    }

    const { videoId, info } = result;

    return reply.send({
      videoId,
      ...info,
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Endpoint for getting video chapters
fastify.post('/video/chapters', async (request, reply) => {
  try {
    const body = request.body as GetVideoInfoRequest;

    const result = await validateAndFetchVideoChapters(body, reply, fastify.log);
    if (!result) {
      return;
    }

    const { videoId, chapters } = result;

    return reply.send({
      videoId,
      chapters,
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
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
