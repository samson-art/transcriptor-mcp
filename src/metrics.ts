/**
 * Prometheus metrics for /metrics endpoint.
 * Uses prom-client for counters, histograms, gauges.
 * Counts are process-local and reset on restart.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { CacheKeyType } from './cache.js';
import { version } from './version.js';

const register = new Registry();

const defaultLabels = { service: 'api' };
register.setDefaultLabels(defaultLabels);

// HTTP metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestErrorsTotal = new Counter({
  name: 'http_request_errors_total',
  help: 'Total HTTP request errors (4xx/5xx)',
  registers: [register],
});

// Expected 404 — subtitles not found, video not found, private or removed video, etc.
export const http404ExpectedTotal = new Counter({
  name: 'http_404_expected_total',
  help: 'Expected 404 responses (subtitles or video not found, private/removed video)',
  labelNames: ['method', 'route'],
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  registers: [register],
});

// Cache metrics
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['kind'],
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['kind'],
  registers: [register],
});

// Subtitles extraction failures (YouTube + Whisper both failed)
export const subtitlesExtractionFailuresTotal = new Counter({
  name: 'subtitles_extraction_failures_total',
  help: 'Videos where subtitles could not be obtained (neither YouTube nor Whisper)',
  labelNames: ['reason'],
  registers: [register],
});

/**
 * Requests this server makes to a platform's caption endpoint. The 429 that takes subtitles
 * down for a day is a budget on exactly these requests, and the budget is not documented
 * anywhere: counting them is the only way to learn how many fit in a day. `path` is always
 * `yt_dlp` since 1.5.8 and stays so the series continue. `outcome=error` includes a yt-dlp
 * run that failed before it reached the endpoint.
 */
export const subtitleRequestsTotal = new Counter({
  name: 'subtitle_requests_total',
  help: 'Requests to a platform caption endpoint, by outcome; path is yt_dlp (the direct fetch went in 1.5.8)',
  labelNames: ['platform', 'path', 'outcome'],
  registers: [register],
});

/**
 * Tracks that auto-discovery listed but never asked for, counted whenever it answers with
 * the track list instead of a transcript (ADR 006: one track request at most). Every one of
 * these is a track the caller now has to name. Read it against the `not_found` outcome of
 * `get_transcript` in the per-call log line: `subtitles_extraction_failures_total` counts a
 * `no_subtitles` failure only when speech-to-text actually ran.
 */
export const subtitleTracksUntriedTotal = new Counter({
  name: 'subtitle_tracks_untried_total',
  help: 'Listed subtitle tracks auto-discovery did not try before giving up',
  labelNames: ['platform'],
  registers: [register],
});

// Whisper transcription requests
export const whisperRequestsTotal = new Counter({
  name: 'whisper_requests_total',
  help: 'Total requests to Whisper (transcription attempts)',
  labelNames: ['mode'],
  registers: [register],
});

/** In-flight deduplicated background Whisper jobs (see whisper-jobs.ts). */
export const whisperBackgroundJobsActive = new Gauge({
  name: 'whisper_background_jobs_active',
  help: 'Number of in-flight background Whisper transcription jobs',
  registers: [register],
});

// Child processes (yt-dlp and ffmpeg share one cap; see youtube.ts)
export const ytDlpProcessesActive = new Gauge({
  name: 'yt_dlp_processes_active',
  help: 'Child processes (yt-dlp/ffmpeg) running right now',
  registers: [register],
});

export const ytDlpQueueLength = new Gauge({
  name: 'yt_dlp_queue_length',
  help: 'Calls waiting for a child-process slot',
  registers: [register],
});

// MCP metrics (labels set when used from MCP)
export const mcpToolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'MCP tool calls, counted when the call starts (failed calls included)',
  labelNames: ['tool'],
  registers: [register],
});

export const mcpToolErrorsTotal = new Counter({
  name: 'mcp_tool_errors_total',
  help: 'Total MCP tool errors',
  labelNames: ['tool', 'reason'],
  registers: [register],
});

export const mcpRequestDurationSeconds = new Histogram({
  name: 'mcp_request_duration_seconds',
  help: 'MCP tool call duration in seconds; outcome is ok or error',
  labelNames: ['endpoint', 'outcome'],
  buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  registers: [register],
});

// Build and dependency versions. Cardinality is fine: these change on deploy only.
export const buildInfo = new Gauge({
  name: 'transcriptor_build_info',
  help: 'Always 1; the labels carry the server and yt-dlp versions',
  labelNames: ['version', 'yt_dlp_version'],
  registers: [register],
});

export const ytDlpOutdated = new Gauge({
  name: 'yt_dlp_outdated',
  help: '1 when the installed yt-dlp is older than the latest release',
  registers: [register],
});

// Canary: does the transcript path still work end to end from this host?
export const canaryOk = new Gauge({
  name: 'transcriptor_canary_ok',
  help: '1 when the last canary transcript fetch succeeded',
  registers: [register],
});

export const canaryLastSuccessTimestampSeconds = new Gauge({
  name: 'transcriptor_canary_last_success_timestamp_seconds',
  help: 'Unix time of the last successful canary transcript fetch',
  registers: [register],
});

// Set by subtitle-rate-limit.ts; the alert on it is `>= 2`.
export const subtitleRateLimitStrikes = new Gauge({
  name: 'subtitle_rate_limit_strikes',
  help: '429s in a row from a platform caption endpoint with no track in between; 0 once a track arrives, and after a restart. 2 or more: this address is banned',
  labelNames: ['platform'],
  registers: [register],
});

// Bounded ring buffer for failed subtitles URLs (max 100)
const FAILURES_BUFFER_SIZE = 100;
const failuresBuffer: Array<{ url: string; timestamp: string }> = [];
let failuresTotalCount = 0;

export function recordRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number
): void {
  httpRequestsTotal.inc({ method, route, status_code: String(statusCode) });
  httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
  if (statusCode >= 400) {
    httpRequestErrorsTotal.inc();
  }
}

export function recordError(): void {
  httpRequestErrorsTotal.inc();
}

export function recordExpected404(method: string, route: string): void {
  http404ExpectedTotal.inc({ method, route });
}

export function recordCacheHit(kind: CacheKeyType): void {
  cacheHitsTotal.inc({ kind });
}

export function recordCacheMiss(kind: CacheKeyType): void {
  cacheMissesTotal.inc({ kind });
}

export function recordSubtitlesFailure(url: string, reason: string): void {
  subtitlesExtractionFailuresTotal.inc({ reason });
  failuresTotalCount += 1;
  const entry = { url, timestamp: new Date().toISOString() };
  if (failuresBuffer.length >= FAILURES_BUFFER_SIZE) {
    failuresBuffer.shift();
  }
  failuresBuffer.push(entry);
}

export function recordUntriedTracks(platform: string, count: number): void {
  if (count > 0) subtitleTracksUntriedTotal.inc({ platform }, count);
}

const SUBTITLE_OUTCOMES = ['ok', 'rate_limited', 'error'] as const;

/**
 * Gives a platform all three series at zero before its first request goes out. A counter
 * that first appears already holding the value it was incremented to leaves `increase()`
 * nothing to diff against, so the first 429 after a restart produces no step and an alert
 * built on it stays silent — which is the one moment the alert exists for. Measured on
 * 2026-09-23: a refusal at 15:00 UTC raised the series from nothing straight to 1, and the
 * rule saw a flat line.
 */
export function primeSubtitleRequests(platform: string): void {
  for (const outcome of SUBTITLE_OUTCOMES) {
    subtitleRequestsTotal.inc({ platform, path: 'yt_dlp', outcome }, 0);
  }
}

export function recordSubtitleRequest(
  platform: string,
  outcome: 'ok' | 'rate_limited' | 'error'
): void {
  subtitleRequestsTotal.inc({ platform, path: 'yt_dlp', outcome });
}

export function setSubtitleRateLimitStrikes(platform: string, strikes: number): void {
  subtitleRateLimitStrikes.set({ platform }, strikes);
}

export function recordWhisperRequest(mode: 'local' | 'api'): void {
  whisperRequestsTotal.inc({ mode });
}

export function setWhisperBackgroundJobsActive(count: number): void {
  whisperBackgroundJobsActive.set(count);
}

export function getFailedSubtitlesUrls(): {
  failures: Array<{ url: string; timestamp: string }>;
  total: number;
} {
  return {
    failures: [...failuresBuffer],
    total: failuresTotalCount,
  };
}

export function setYtDlpVersionInfo(installed: string | null, outdated: boolean): void {
  // Reset first: an in-place upgrade must not leave the old version as a second series.
  buildInfo.reset();
  buildInfo.set({ version, yt_dlp_version: installed ?? 'unknown' }, 1);
  ytDlpOutdated.set(outdated ? 1 : 0);
}

export function setCanaryResult(ok: boolean): void {
  canaryOk.set(ok ? 1 : 0);
  if (ok) canaryLastSuccessTimestampSeconds.setToCurrentTime();
}

export function setYtDlpProcessGauges(active: number, queued: number): void {
  ytDlpProcessesActive.set(active);
  ytDlpQueueLength.set(queued);
}

export function recordMcpToolCall(tool: string): void {
  mcpToolCallsTotal.inc({ tool });
}

export function recordMcpToolError(tool: string, reason: string): void {
  mcpToolErrorsTotal.inc({ tool, reason });
}

export function recordMcpRequestDuration(
  endpoint: string,
  durationSeconds: number,
  outcome: 'ok' | 'error'
): void {
  mcpRequestDurationSeconds.observe({ endpoint, outcome }, durationSeconds);
}

/**
 * Returns Prometheus text exposition format (UTF-8).
 */
export async function renderPrometheus(): Promise<string> {
  return register.metrics();
}
