/**
 * A healthy process does not mean YouTube still answers this host. Bot checks and
 * IP-level throttling arrive silently: nothing crashes, every request just starts
 * failing. This runs the real transcript path on a fixed video at a fixed interval
 * so the failure shows up as a metric and one alert instead of user reports.
 *
 * The probe bypasses the response cache: a cached fixture would prove Redis works,
 * not that yt-dlp still reaches YouTube.
 */
import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger } from 'fastify';

import { parseIntEnv } from './env.js';
import { errorReason, ServerBusyError } from './errors.js';
import { setCanaryResult } from './metrics.js';
import { lastSubtitlesAnswered } from './subtitle-rate-limit.js';
import { validateAndDownloadSubtitles } from './validation.js';

/** "Me at the zoo": public since 2005, 19 seconds, official English captions (no auto track). */
const DEFAULT_CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** One failure is noise (a flaky run, a slow platform); two in a row is a pattern. */
const FAILURES_BEFORE_ALERT = 2;

let consecutiveFailures = 0;

/** Runs one canary probe and records its outcome. Never throws. */
export async function runCanary(log: FastifyBaseLogger): Promise<void> {
  const url = process.env.CANARY_URL?.trim() || DEFAULT_CANARY_URL;
  // A transcript that came back from this platform within the last interval proves exactly
  // what this probe would, and it cost a request somebody actually wanted. Platforms meter
  // caption requests hard enough to take the tool down for a day, so the probe only runs
  // when nothing has answered lately — which is also the only time its answer is news.
  if (
    Date.now() - lastSubtitlesAnswered(url) <
    parseIntEnv('CANARY_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  ) {
    log.debug({ url }, 'canary: skipped, a real call just came back from this platform');
    setCanaryResult(true);
    consecutiveFailures = 0;
    return;
  }
  try {
    // Explicit type and lang keep this to one caption download (the YouTube URL already
    // carries the id); omitting them would fan out over the auto-discovery ladder.
    await validateAndDownloadSubtitles({ url, type: 'official', lang: 'en' }, log, {
      skipCache: true,
    });
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
    const reason = errorReason(err);
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
 * Starts the periodic probe. Only the HTTP server starts it: the stdio server is
 * a short-lived per-client process with no one to alert.
 */
export function startCanary(log: FastifyBaseLogger): void {
  const intervalMs = parseIntEnv('CANARY_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  if (intervalMs <= 0) {
    return;
  }
  // Probe once at boot: otherwise the gauge reads 0 for the first interval and
  // looks like a failure.
  void runCanary(log);
  setInterval(() => {
    void runCanary(log);
  }, intervalMs).unref();
}

/** Test helper: clears the failure streak between cases. */
export function resetCanaryForTests(): void {
  consecutiveFailures = 0;
}
