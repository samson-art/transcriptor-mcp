import type { FastifyBaseLogger } from 'fastify';
import * as Sentry from '@sentry/node';
import { parseIntEnv } from './env.js';

export type LifecycleOptions = {
  /** Server instance with close() method */
  server: { close: () => Promise<void> };
  /** Cache close function */
  closeCache: () => Promise<void>;
  /** Logger */
  log: FastifyBaseLogger;
  /** Shutdown timeout in ms (default from SHUTDOWN_TIMEOUT env or 10000) */
  shutdownTimeout?: number;
  /** Message to log on successful shutdown (default: "Server closed successfully") */
  shutdownSuccessMessage?: string;
  /** Optional Sentry context when capturing shutdown errors */
  sentryContext?: Record<string, unknown>;
};

let isShuttingDown = false;

/**
 * Registers process signal handlers (SIGTERM, SIGINT) and error handlers
 * (unhandledRejection, uncaughtException). Returns a shutdown function.
 */
export function setupLifecycle(options: LifecycleOptions): (signal: string) => Promise<void> {
  const {
    server,
    closeCache,
    log,
    shutdownTimeout = parseIntEnv('SHUTDOWN_TIMEOUT', 10000),
    shutdownSuccessMessage = 'Server closed successfully',
    sentryContext,
  } = options;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`Received ${signal}, starting graceful shutdown...`);

    const forceShutdownTimer = setTimeout(() => {
      log.warn('Shutdown timeout reached, forcing exit...');
      process.exit(1);
    }, shutdownTimeout);

    try {
      await server.close();
      await closeCache();
      clearTimeout(forceShutdownTimer);
      log.info(shutdownSuccessMessage);
      process.exit(0);
    } catch (err) {
      clearTimeout(forceShutdownTimer);
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(error, 'Error during shutdown');
      if (sentryContext) {
        Sentry.withScope((scope) => {
          scope.setContext('shutdown', sentryContext);
          Sentry.captureException(error);
        });
      } else {
        Sentry.captureException(error);
      }
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    let error: Error;
    if (reason instanceof Error) {
      error = reason;
    } else if (typeof reason === 'string') {
      error = new Error(reason);
    } else if (reason !== null && reason !== undefined) {
      error = new Error(JSON.stringify(reason));
    } else {
      error = new Error('Unknown rejection');
    }
    log.error(error, 'Unhandled Rejection');
    Sentry.captureException(error);
  });

  process.on('uncaughtException', (error) => {
    log.error(error, 'Uncaught Exception');
    Sentry.captureException(error);
    void shutdown('uncaughtException');
  });

  return shutdown;
}
