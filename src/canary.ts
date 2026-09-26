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
import { lastSubtitlesAnswered, subtitlesRefusedSinceTrack } from './subtitle-rate-limit.js';
import { normalizeVideoInput, validateAndDownloadSubtitles } from './validation.js';

/** "Me at the zoo": public since 2005, 19 seconds, official English captions (no auto track). */
const DEFAULT_CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** One failure is noise (a flaky run, a slow platform); two in a row is a pattern. */
const FAILURES_BEFORE_ALERT = 2;

let consecutiveFailures = 0;
/** The stamp of the last delivered probe's own track. */
let probedAt = 0;

/** The path works: end the streak, and say so if the streak had raised the alert. */
function pathWorks(log: FastifyBaseLogger, url: string, via: 'probe' | 'traffic'): void {
  setCanaryResult(true);
  if (consecutiveFailures >= FAILURES_BEFORE_ALERT) {
    log.info({ url, via }, 'canary: transcript path recovered');
    Sentry.captureMessage('canary: transcript path recovered', { level: 'info', tags: { via } });
  }
  consecutiveFailures = 0;
}

/** Runs one canary probe and records its outcome. Never throws. */
export async function runCanary(log: FastifyBaseLogger): Promise<void> {
  const raw = process.env.CANARY_URL?.trim() || DEFAULT_CANARY_URL;
  // The probe stamps the normalized URL's platform: a bare id must read that same platform.
  const url = normalizeVideoInput(raw) ?? raw;
  // A transcript that came back from this platform within the last interval proves exactly
  // what this probe would, and it cost a request somebody actually wanted. Platforms meter
  // caption requests hard enough to take the tool down for a day, so the probe only runs
  // when nothing has answered lately — which is also the only time its answer is news.
  // The probe's own track stamps the platform too, one interval minus its run before the
  // next tick; counting it made an idle server probe every second interval (#48). After a 429
  // with no track since, an older track proves nothing: during the hold the probe stops at the
  // hold with no request, and after it the probe asks the platform.
  const answered = lastSubtitlesAnswered(url);
  if (
    !subtitlesRefusedSinceTrack(url) &&
    answered > probedAt &&
    Date.now() - answered < parseIntEnv('CANARY_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  ) {
    log.debug({ url }, 'canary: skipped, a real call just came back from this platform');
    pathWorks(log, url, 'traffic');
    return;
  }
  try {
    // Explicit type and lang keep this to one caption download with no metadata run in
    // front of it (the YouTube URL already carries the id); auto-discovery would add one.
    await validateAndDownloadSubtitles({ url, type: 'official', lang: 'en' }, log, {
      skipCache: true,
    });
    // ponytail: a real track that lands while a probe runs to success is taken for the
    // probe's own, so the next tick may probe once more than it had to; a per-call origin
    // tag in subtitle-rate-limit.ts would fix that if it ever shows in the request counts.
    probedAt = lastSubtitlesAnswered(url);
    pathWorks(log, url, 'probe');
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

/** Test helper: clears the failure streak and the last probe between cases. */
export function resetCanaryForTests(): void {
  consecutiveFailures = 0;
  probedAt = 0;
}
