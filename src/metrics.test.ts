import {
  recordMcpHttpRequestByClientIp,
  recordMcpQuotaCheck,
  recordMcpQuotaCheckDuration,
  recordMcpQuotaExceeded,
  recordMcpQuotaHttp429,
  recordMcpQuotaToolBlocked,
  renderPrometheus,
  resetMetricsRegistryForTests,
  setMetricsService,
} from './metrics.js';

/** Parses a single counter line for metrics that use default labels (e.g. service=mcp). */
function counterValue(exposition: string, metric: string, requiredSubstrings: string[]): number {
  for (const line of exposition.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(`${metric}{`)) continue;
    if (!requiredSubstrings.every((s) => line.includes(s))) continue;
    const tail = line.match(/\}\s+(\d+(?:\.\d+)?)$/);
    if (tail) return Number(tail[1]);
  }
  throw new Error(`Metric line not found: ${metric} with ${requiredSubstrings.join(', ')}`);
}

function histogramCount(exposition: string, metric: string): number {
  for (const line of exposition.split('\n')) {
    if (line.startsWith(`${metric}_count{`) || line.startsWith(`${metric}_count `)) {
      const tail = line.match(/\}\s+(\d+(?:\.\d+)?)$/);
      if (tail) return Number(tail[1]);
    }
  }
  throw new Error(`Histogram count not found: ${metric}`);
}

function histogramSum(exposition: string, metric: string): number {
  for (const line of exposition.split('\n')) {
    if (line.startsWith(`${metric}_sum{`) || line.startsWith(`${metric}_sum `)) {
      const tail = line.match(/\}\s+([\d.eE+-]+)$/);
      if (tail) return Number(tail[1]);
    }
  }
  throw new Error(`Histogram sum not found: ${metric}`);
}

describe('MCP quota metrics', () => {
  beforeEach(() => {
    resetMetricsRegistryForTests();
    setMetricsService('mcp');
  });

  afterAll(() => {
    resetMetricsRegistryForTests();
    setMetricsService('api');
  });

  it('exports mcp_quota_checks_total with result and tier labels', async () => {
    recordMcpQuotaCheck('allowed', 'default');
    recordMcpQuotaCheck('allowed', 'registered');
    recordMcpQuotaCheck('exceeded', 'anonymous');
    recordMcpQuotaCheck('rejected_no_key', 'anonymous');
    recordMcpQuotaCheck('rejected_invalid_key', 'anonymous');

    const text = await renderPrometheus();
    expect(text).toContain('mcp_quota_checks_total');

    expect(
      counterValue(text, 'mcp_quota_checks_total', ['result="allowed"', 'tier="default"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_checks_total', ['result="allowed"', 'tier="registered"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_checks_total', ['result="exceeded"', 'tier="anonymous"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_checks_total', ['result="rejected_no_key"', 'tier="anonymous"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_checks_total', [
        'result="rejected_invalid_key"',
        'tier="anonymous"',
      ])
    ).toBe(1);
  });

  it('exports mcp_quota_exceeded_total with tier and key_id', async () => {
    recordMcpQuotaExceeded('default');
    recordMcpQuotaExceeded('registered', 'client-a');

    const text = await renderPrometheus();
    expect(
      counterValue(text, 'mcp_quota_exceeded_total', ['tier="default"', 'key_id="none"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_exceeded_total', ['tier="registered"', 'key_id="client-a"'])
    ).toBe(1);
  });

  it('exports mcp_quota_tool_calls_blocked_total by tool', async () => {
    recordMcpQuotaToolBlocked('get_transcript');
    recordMcpQuotaToolBlocked('get_transcript');
    recordMcpQuotaToolBlocked('search_videos');

    const text = await renderPrometheus();
    expect(
      counterValue(text, 'mcp_quota_tool_calls_blocked_total', ['tool="get_transcript"'])
    ).toBe(2);
    expect(counterValue(text, 'mcp_quota_tool_calls_blocked_total', ['tool="search_videos"'])).toBe(
      1
    );
  });

  it('exports mcp_quota_http_429_total by route', async () => {
    recordMcpQuotaHttp429('/mcp');
    recordMcpQuotaHttp429('/sse');

    const text = await renderPrometheus();
    expect(counterValue(text, 'mcp_quota_http_429_total', ['route="/mcp"'])).toBe(1);
    expect(counterValue(text, 'mcp_quota_http_429_total', ['route="/sse"'])).toBe(1);
  });

  it('records mcp_quota_check_duration_seconds histogram', async () => {
    recordMcpQuotaCheckDuration(0.002);
    recordMcpQuotaCheckDuration(0.004);

    const text = await renderPrometheus();
    expect(text).toContain('mcp_quota_check_duration_seconds_bucket');
    expect(text).toContain('mcp_quota_check_duration_seconds_sum');
    expect(text).toContain('mcp_quota_check_duration_seconds_count');
    expect(histogramCount(text, 'mcp_quota_check_duration_seconds')).toBe(2);
    expect(histogramSum(text, 'mcp_quota_check_duration_seconds')).toBeCloseTo(0.006, 10);
  });

  it('exports mcp_http_requests_by_client_ip_total by route, method, and client_ip', async () => {
    recordMcpHttpRequestByClientIp('/mcp', 'POST', '203.0.113.1');
    recordMcpHttpRequestByClientIp('/mcp', 'POST', '203.0.113.1');
    recordMcpHttpRequestByClientIp('/health', 'GET', '2001:db8::1');

    const text = await renderPrometheus();
    expect(text).toContain('mcp_http_requests_by_client_ip_total');
    expect(
      counterValue(text, 'mcp_http_requests_by_client_ip_total', [
        'route="/mcp"',
        'method="POST"',
        'client_ip="203.0.113.1"',
      ])
    ).toBe(2);
    expect(
      counterValue(text, 'mcp_http_requests_by_client_ip_total', [
        'route="/health"',
        'method="GET"',
        'client_ip="2001:db8::1"',
      ])
    ).toBe(1);
  });

  it('increments check and exceeded independently for an exceed flow', async () => {
    recordMcpQuotaCheck('exceeded', 'registered');
    recordMcpQuotaExceeded('registered', 'k1');
    recordMcpQuotaToolBlocked('get_transcript');

    const text = await renderPrometheus();
    expect(
      counterValue(text, 'mcp_quota_checks_total', ['result="exceeded"', 'tier="registered"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_exceeded_total', ['tier="registered"', 'key_id="k1"'])
    ).toBe(1);
    expect(
      counterValue(text, 'mcp_quota_tool_calls_blocked_total', ['tool="get_transcript"'])
    ).toBe(1);
  });
});
