import type { FastifyBaseLogger } from 'fastify';
import { parseIntEnv } from './env.js';
import { ServerBusyError } from './errors.js';
import { setWhisperBackgroundJobsActive } from './metrics.js';
import { getWhisperConfig, transcribeWithWhisper, type WhisperResponseFormat } from './whisper.js';

const inflightJobs = new Map<string, Promise<string | null>>();

function whisperJobKey(url: string, lang: string, format: WhisperResponseFormat): string {
  return `${url}\0${lang}\0${format}`;
}

function syncGauge(): void {
  setWhisperBackgroundJobsActive(inflightJobs.size);
}

/**
 * Max time (ms) for a single background Whisper HTTP call.
 * Env `WHISPER_BACKGROUND_TIMEOUT`: unset = max(30m, 3 × WHISPER_TIMEOUT); `0` = no client abort.
 */
export function getWhisperBackgroundTimeoutMs(): number {
  const raw = process.env.WHISPER_BACKGROUND_TIMEOUT?.trim();
  if (raw === '0') {
    return 0;
  }
  if (raw !== undefined && raw !== '') {
    return Math.max(0, parseIntEnv('WHISPER_BACKGROUND_TIMEOUT', 0));
  }
  const cfg = getWhisperConfig();
  return Math.max(1_800_000, cfg.timeout * 3);
}

/**
 * Starts or reuses an in-flight Whisper transcription for the same url/lang/format.
 * Uses {@link getWhisperBackgroundTimeoutMs} for the HTTP client (longer than per-request race).
 */
export function startOrReuseWhisperJob(
  url: string,
  lang: string,
  format: WhisperResponseFormat,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const key = whisperJobKey(url, lang, format);
  const existing = inflightJobs.get(key);
  if (existing) {
    return existing;
  }
  // Each job holds its whole audio file in memory, and in API mode it costs money (#132). A call
  // that joins a running job above costs nothing, so only a new job is refused.
  const max = parseIntEnv('WHISPER_MAX_CONCURRENCY', 2);
  if (max > 0 && inflightJobs.size >= max) {
    throw new ServerBusyError();
  }

  const bgTimeoutMs = getWhisperBackgroundTimeoutMs();
  const promise = (async (): Promise<string | null> => {
    try {
      return await transcribeWithWhisper(url, lang, format, logger, bgTimeoutMs);
    } finally {
      inflightJobs.delete(key);
      syncGauge();
    }
  })();

  inflightJobs.set(key, promise);
  syncGauge();
  return promise;
}

export function getPendingWhisperJobCount(): number {
  return inflightJobs.size;
}

/** Test helper: clears in-flight map and gauge. */
export function clearInflightJobsForTests(): void {
  inflightJobs.clear();
  syncGauge();
}
