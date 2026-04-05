/**
 * Prometheus metrics for /metrics endpoint.
 * Uses prom-client for counters, histograms, gauges.
 * Counts are process-local and reset on restart.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

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

// Expected 404 (NotFoundError) — subtitles not found, video not found, etc.
export const http404ExpectedTotal = new Counter({
  name: 'http_404_expected_total',
  help: 'Expected 404 responses (NotFoundError: subtitles/video not found)',
  labelNames: ['method', 'route'],
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Cache metrics
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  registers: [register],
});

// Subtitles extraction failures (YouTube + Whisper both failed)
export const subtitlesExtractionFailuresTotal = new Counter({
  name: 'subtitles_extraction_failures_total',
  help: 'Videos where subtitles could not be obtained (neither YouTube nor Whisper)',
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

// MCP metrics (labels set when used from MCP)
export const mcpToolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['tool'],
  registers: [register],
});

export const mcpToolErrorsTotal = new Counter({
  name: 'mcp_tool_errors_total',
  help: 'Total MCP tool errors',
  labelNames: ['tool'],
  registers: [register],
});

export const mcpSessionTotal = new Gauge({
  name: 'mcp_session_total',
  help: 'Active MCP sessions',
  labelNames: ['type'],
  registers: [register],
});

export const mcpRequestDurationSeconds = new Histogram({
  name: 'mcp_request_duration_seconds',
  help: 'MCP request duration in seconds',
  labelNames: ['endpoint'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** Outcome of a quota check before `tools/call` (plan: observability / cardinality-safe tiers). */
export type McpQuotaCheckResult =
  | 'allowed'
  | 'exceeded'
  | 'rejected_no_key'
  | 'rejected_invalid_key';

/** Quota tier for metrics labels (`anonymous` = unregistered / unknown key bucket). */
export type McpQuotaTier = 'registered' | 'default' | 'anonymous';

export const mcpQuotaChecksTotal = new Counter({
  name: 'mcp_quota_checks_total',
  help: 'MCP quota checks before tools/call',
  labelNames: ['result', 'tier'],
  registers: [register],
});

/** Use `key_id="none"` when the exceed is not tied to a registry entry. */
export const mcpQuotaExceededTotal = new Counter({
  name: 'mcp_quota_exceeded_total',
  help: 'MCP quota limit exceeded (decision before responding to client)',
  labelNames: ['tier', 'key_id'],
  registers: [register],
});

export const mcpQuotaToolCallsBlockedTotal = new Counter({
  name: 'mcp_quota_tool_calls_blocked_total',
  help: 'MCP tool calls blocked by quota',
  labelNames: ['tool'],
  registers: [register],
});

export const mcpQuotaHttp429Total = new Counter({
  name: 'mcp_quota_http_429_total',
  help: 'HTTP 429 responses emitted for MCP quota before the MCP session',
  labelNames: ['route'],
  registers: [register],
});

export const mcpQuotaCheckDurationSeconds = new Histogram({
  name: 'mcp_quota_check_duration_seconds',
  help: 'Duration of a single MCP quota check (Redis / in-memory)',
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
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

export function recordCacheHit(): void {
  cacheHitsTotal.inc();
}

export function recordCacheMiss(): void {
  cacheMissesTotal.inc();
}

export function recordSubtitlesFailure(url: string): void {
  subtitlesExtractionFailuresTotal.inc();
  failuresTotalCount += 1;
  const entry = { url, timestamp: new Date().toISOString() };
  if (failuresBuffer.length >= FAILURES_BUFFER_SIZE) {
    failuresBuffer.shift();
  }
  failuresBuffer.push(entry);
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

export function recordMcpToolCall(tool: string): void {
  mcpToolCallsTotal.inc({ tool });
}

export function recordMcpToolError(tool: string): void {
  mcpToolErrorsTotal.inc({ tool });
}

export function setMcpSessionCount(type: 'streamable' | 'sse', count: number): void {
  mcpSessionTotal.set({ type }, count);
}

export function recordMcpRequestDuration(endpoint: string, durationSeconds: number): void {
  mcpRequestDurationSeconds.observe({ endpoint }, durationSeconds);
}

export function recordMcpQuotaCheck(result: McpQuotaCheckResult, tier: McpQuotaTier): void {
  mcpQuotaChecksTotal.inc({ result, tier });
}

/**
 * @param keyId Stable registry id for registered keys; use `none` when not applicable.
 */
export function recordMcpQuotaExceeded(tier: McpQuotaTier, keyId: string = 'none'): void {
  mcpQuotaExceededTotal.inc({ tier, key_id: keyId });
}

export function recordMcpQuotaToolCallsBlocked(tool: string): void {
  mcpQuotaToolCallsBlockedTotal.inc({ tool });
}

/** Alias for {@link recordMcpQuotaToolCallsBlocked} (stdio quota module naming). */
export function recordMcpQuotaToolBlocked(tool: string): void {
  recordMcpQuotaToolCallsBlocked(tool);
}

export function recordMcpQuotaHttp429(route: string): void {
  mcpQuotaHttp429Total.inc({ route });
}

export function recordMcpQuotaCheckDuration(durationSeconds: number): void {
  mcpQuotaCheckDurationSeconds.observe(durationSeconds);
}

/**
 * Sets default labels (service=api or service=mcp). Call from mcp-http to override.
 */
export function setMetricsService(service: 'api' | 'mcp'): void {
  register.setDefaultLabels({ service });
}

/**
 * Returns Prometheus text exposition format (UTF-8).
 */
export async function renderPrometheus(): Promise<string> {
  return register.metrics();
}

/** Resets all metric values (for tests only). */
export function resetMetricsRegistryForTests(): void {
  register.resetMetrics();
}
