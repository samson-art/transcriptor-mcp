/**
 * In-memory counters for Prometheus /metrics endpoint.
 * Counts are process-local and reset on restart.
 */

const counters: Record<string, number> = {
  http_requests_total: 0,
  http_request_errors_total: 0,
  cache_hits_total: 0,
  cache_misses_total: 0,
};

export function recordRequest(): void {
  counters.http_requests_total += 1;
}

export function recordError(): void {
  counters.http_request_errors_total += 1;
}

export function recordCacheHit(): void {
  counters.cache_hits_total += 1;
}

export function recordCacheMiss(): void {
  counters.cache_misses_total += 1;
}

/**
 * Renders Prometheus text exposition format (UTF-8).
 */
export function renderPrometheus(): string {
  const lines: string[] = [
    '# HELP http_requests_total Total HTTP requests.',
    '# TYPE http_requests_total counter',
    `http_requests_total ${counters.http_requests_total}`,
    '# HELP http_request_errors_total Total HTTP request errors (4xx/5xx).',
    '# TYPE http_request_errors_total counter',
    `http_request_errors_total ${counters.http_request_errors_total}`,
    '# HELP cache_hits_total Total cache hits.',
    '# TYPE cache_hits_total counter',
    `cache_hits_total ${counters.cache_hits_total}`,
    '# HELP cache_misses_total Total cache misses.',
    '# TYPE cache_misses_total counter',
    `cache_misses_total ${counters.cache_misses_total}`,
  ];
  return lines.join('\n') + '\n';
}
