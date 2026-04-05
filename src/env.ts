/**
 * Parses a string as an integer, returning defaultValue if the result is NaN.
 */
export function parseIntFromString(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parses an environment variable as an integer, returning defaultValue if
 * the variable is unset, empty, or does not parse to a finite number.
 */
export function parseIntEnv(name: string, defaultValue: number): number {
  return parseIntFromString(process.env[name], defaultValue);
}

/**
 * Parses duration strings for MCP quota windows (env defaults and registry `window` fields).
 * Supported: compact units (100ms, 5s, 30m, 24h, 7d) and phrases (1 minute, 2 hours).
 */
export function parseQuotaWindowMs(spec: string): number {
  const s = spec.trim().toLowerCase();
  if (!s) {
    throw new Error('empty quota window');
  }

  const compact = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s);
  if (compact) {
    const n = Number(compact[1]);
    if (n === 0) {
      throw new Error('quota window must be positive');
    }
    const u = compact[2];
    const mult: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return n * mult[u];
  }

  const words = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/.exec(s);
  if (words) {
    const n = Number(words[1]);
    if (n === 0) {
      throw new Error('quota window must be positive');
    }
    const w = words[2];
    if (w.startsWith('minute')) {
      return n * 60_000;
    }
    if (w.startsWith('hour')) {
      return n * 3_600_000;
    }
    if (w.startsWith('day')) {
      return n * 86_400_000;
    }
  }

  throw new Error(`Invalid quota window: ${spec}`);
}

/**
 * Parses `MCP_TRUST_PROXY` for Fastify `trustProxy`
 * (https://fastify.dev/docs/latest/Reference/Server/#trustproxy).
 *
 * Behind a reverse proxy (nginx, Traefik, Cloudflare, Smithery, etc.), the TCP peer is usually the
 * proxy, not the end client. When trust is configured, Fastify sets `request.ip` from `X-Forwarded-For`
 * using `@fastify/proxy-addr` (same semantics as Express: the leftmost untrusted hop is the client).
 *
 * **Values**
 * - Unset or empty: `true` — use the forwarded chain (typical when the app is only reachable via a load balancer).
 * - `0`, `false`, `no`, `off`: `false` — `request.ip` is the socket peer; forwarded headers are not used for IP.
 * - `true`, `yes`, `on`: `true` — trust the full `X-Forwarded-For` chain.
 * - A positive integer (`1`, `2`, …): number of trusted proxy hops (see Fastify / proxy-addr docs).
 * - Any other non-empty string: passed through (comma-separated IPs, CIDR, or names such as `loopback`).
 *
 * If clients can reach the process **without** a proxy, trusting forwarded headers allows IP spoofing;
 * use `false` or match your deployment’s hop count.
 */
export function parseMcpTrustProxyEnv(): boolean | number | string {
  const raw = process.env.MCP_TRUST_PROXY?.trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === 'no' || lower === 'off' || lower === '0') {
    return false;
  }
  if (lower === 'true' || lower === 'yes' || lower === 'on') {
    return true;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? n : false;
  }
  return raw;
}

/**
 * When true (default), increments `mcp_http_requests_by_client_ip_total` per HTTP request with
 * `route`, `method`, and `client_ip` labels. Disable (`0`/`false`/`no`/`off`) on high-traffic
 * deployments to avoid Prometheus cardinality from many unique IPs.
 */
export function isMcpMetricsHttpRequestsByClientIpEnabled(): boolean {
  const v = process.env.MCP_METRICS_HTTP_REQUESTS_BY_CLIENT_IP?.trim().toLowerCase();
  if (v === undefined || v === '') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return v === '1' || v === 'true' || v === 'yes';
}
