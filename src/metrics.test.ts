import * as metrics from './metrics.js';

// Dashboards and alerts read these names, labels and histogram buckets. A rename breaks
// them without a message, so this list is the contract. To make a planned change, edit
// the list in the same PR, so that the change shows in the diff.
const CONTRACT = [
  ['cache_hits_total', 'counter', ['kind']],
  ['cache_misses_total', 'counter', ['kind']],
  ['http_404_expected_total', 'counter', ['method', 'route']],
  [
    'http_request_duration_seconds',
    'histogram',
    ['method', 'route'],
    [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  ],
  ['http_request_errors_total', 'counter', []],
  ['http_requests_total', 'counter', ['method', 'route', 'status_code']],
  [
    'mcp_request_duration_seconds',
    'histogram',
    ['endpoint', 'outcome'],
    [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  ],
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

// getMetricsAsArray returns the metric objects, but prom-client types them as plain
// MetricObject. labelNames and buckets come from the constructor options and are untyped.
type Registered = {
  get(): Promise<{ name: string; type: string }>;
  labelNames: string[];
  buckets?: number[];
};

describe('metrics contract', () => {
  it('keeps the name, the type, the label names and the buckets of every registered metric', async () => {
    // The registry, not the exports: a Summary or an unexported metric is on /metrics too.
    const actual = await Promise.all(
      (metrics.register.getMetricsAsArray() as unknown as Registered[]).map(async (m) => {
        const { name, type } = await m.get();
        const { labelNames, buckets } = m;
        return type === 'histogram' ? [name, type, labelNames, buckets] : [name, type, labelNames];
      })
    );
    // Code-point order, so that the result does not depend on the locale of the machine.
    actual.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));

    expect(actual).toEqual(CONTRACT);
  });

  it('puts service="api" on every series line', async () => {
    metrics.recordError();
    metrics.recordRequest('GET', '/health', 200, 0.01);
    const series = (await metrics.renderPrometheus())
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(series.length).toBeGreaterThan(0);
    expect(series.filter((line) => !line.includes('service="api"'))).toEqual([]);
  });
});
