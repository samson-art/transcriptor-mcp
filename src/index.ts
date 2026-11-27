import * as Sentry from '@sentry/node';
import { checkYtDlpAtStartup } from './yt-dlp-check.js';
import { close as closeCache } from './cache.js';
import { setupLifecycle } from './lifecycle.js';
import { parseIntEnv } from './env.js';
import { buildRestApp } from './rest-app.js';

const fastify = buildRestApp();

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
