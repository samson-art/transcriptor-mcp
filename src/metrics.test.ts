import { Counter, Gauge, Histogram } from 'prom-client';

import * as metrics from './metrics.js';

// Dashboards and alerts read these names and labels. A rename breaks them without a
// message, so this list is the contract. To make a planned change, edit the list in the
// same PR, so that the change shows in the diff.
const CONTRACT = [
  ['cache_hits_total', 'counter', ['kind']],
  ['cache_misses_total', 'counter', ['kind']],
  ['http_404_expected_total', 'counter', ['method', 'route']],
  ['http_request_duration_seconds', 'histogram', ['method', 'route']],
  ['http_request_errors_total', 'counter', []],
  ['http_requests_total', 'counter', ['method', 'route', 'status_code']],
  ['mcp_request_duration_seconds', 'histogram', ['endpoint', 'outcome']],
  ['mcp_tool_calls_total', 'counter', ['tool', 'source']],
  ['mcp_tool_errors_total', 'counter', ['tool', 'reason']],
  ['subtitle_rate_limit_strikes', 'gauge', ['platform']],
  ['subtitle_requests_total', 'counter', ['platform', 'path', 'outcome']],
  ['subtitle_tracks_untried_total', 'counter', ['platform']],
  ['subtitles_extraction_failures_total', 'counter', ['reason']],
  ['transcriptor_build_info', 'gauge', ['version', 'yt_dlp_version']],
  ['transcriptor_canary_last_success_timestamp_seconds', 'gauge', []],
  ['transcriptor_canary_ok', 'gauge', []],
  ['whisper_background_jobs_active', 'gauge', []],
  ['whisper_requests_total', 'counter', ['mode']],
  ['yt_dlp_outdated', 'gauge', []],
  ['yt_dlp_processes_active', 'gauge', []],
  ['yt_dlp_queue_length', 'gauge', []],
];

describe('metrics contract', () => {
  it('keeps the name, the type and the label names of every metric', async () => {
    const all = Object.values(metrics).filter(
      (m): m is Counter | Gauge | Histogram =>
        m instanceof Counter || m instanceof Gauge || m instanceof Histogram
    );
    const actual = await Promise.all(
      all.map(async (m) => {
        const { name, type } = await m.get();
        // labelNames is set from the constructor options but is not in the typings.
        return [name, type, (m as unknown as { labelNames: string[] }).labelNames];
      })
    );
    actual.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    expect(actual).toEqual(CONTRACT);
  });

  it('adds service="api" to every series', async () => {
    metrics.recordError();
    expect(await metrics.renderPrometheus()).toContain('http_request_errors_total{service="api"}');
  });
});
