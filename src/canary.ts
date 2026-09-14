/**
 * A healthy process does not mean YouTube still answers this host. Bot checks and
 * IP-level throttling arrive silently: nothing crashes, every request just starts
 * failing. This runs the real transcript path on a fixed video at a fixed interval
 * so the failure shows up as a metric and one alert instead of user reports.
 *
 * ponytail: with CACHE_MODE=redis the fixture would come from cache after the first
 * hit (7-day TTL). Add a cache bypass to validateAndDownloadSubtitles if the hosted
 * deployment ever turns caching on.
 */
import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger } from 'fastify';

import { parseIntEnv } from './env.js';
import { HttpError, ServerBusyError, YtDlpError } from './errors.js';
import { setCanaryResult } from './metrics.js';
import { validateAndDownloadSubtitles } from './validation.js';

/** "Me at the zoo": public since 2005, 19 seconds, official captions. */
const DEFAULT_CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** One failure is noise (a flaky run, a slow platform); two in a row is a pattern. */
const FAILURES_BEFORE_ALERT = 2;

let consecutiveFailures = 0;

function failureReason(err: unknown): string {
  if (err instanceof YtDlpError) return err.reason;
  if (err instanceof HttpError) return err.name;
  return 'unknown';
}

/** Runs one canary probe and records its outcome. Never throws. */
export async function runCanary(log: FastifyBaseLogger): Promise<void> {
  const url = process.env.CANARY_URL?.trim() || DEFAULT_CANARY_URL;
  try {
    // Explicit type and lang pin this to a single yt-dlp call; omitting them would
    // fan out over the auto-discovery ladder and cost six.
    await validateAndDownloadSubtitles({ url, type: 'auto', lang: 'en' }, log);
    setCanaryResult(true);
    if (consecutiveFailures >= FAILURES_BEFORE_ALERT) {
      log.info({ url }, 'canary: transcript path recovered');
      Sentry.captureMessage('canary: transcript path recovered', 'info');
    }
    consecutiveFailures = 0;
  } catch (err) {
    if (err instanceof ServerBusyError) {
      // A saturated server is the limiter's story to tell, not a broken path.
      log.warn('canary: skipped, server busy');
      return;
    }
    consecutiveFailures += 1;
    setCanaryResult(false);
    const reason = failureReason(err);
    if (consecutiveFailures === FAILURES_BEFORE_ALERT) {
      log.error({ err, url, reason }, 'canary: transcript path failing');
      Sentry.captureMessage('canary: transcript path failing', {
        level: 'error',
        tags: { reason, canary: 'true' },
      });
    } else {
      log.warn({ err, url, reason, consecutiveFailures }, 'canary: transcript fetch failed');
    }
  }
}

/**
 * Starts the periodic probe. Returns undefined when disabled, so callers can tell
 * "off" from "running". Only the HTTP server starts it: the stdio server is a
 * short-lived per-client process with no one to alert.
 */
export function startCanary(log: FastifyBaseLogger): NodeJS.Timeout | undefined {
  const intervalMs = parseIntEnv('CANARY_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  if (intervalMs <= 0 || process.env.NODE_ENV === 'test') {
    return undefined;
  }
  // Probe once at boot: otherwise the gauge reads 0 for the first interval and
  // looks like a failure.
  void runCanary(log);
  const timer = setInterval(() => {
    void runCanary(log);
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Test helper: clears the failure streak between cases. */
export function resetCanaryForTests(): void {
  consecutiveFailures = 0;
}
