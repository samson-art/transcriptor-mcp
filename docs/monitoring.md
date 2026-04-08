# Monitoring with Prometheus and Grafana

The **REST API** exposes Prometheus metrics on **GET /metrics** (HTTP traffic, cache, Whisper, subtitle failures, etc.). The **MCP stdio** process (`npm run start:mcp`) still increments **`mcp_*`** counters in memory via `mcp-core`, but **this repository no longer serves `GET /metrics` from the MCP image** after removing the in-process HTTP MCP server—there is nowhere to scrape those series unless you add your own exporter or aggregate via logs/Sentry. Port **4200** in [docker-compose.example.yml](../docker-compose.example.yml) is **mcp-proxy** only. Scrape **`:3000/metrics`** for the API; use **proxy metrics**, **Sentry**, or **logs** for remote MCP traffic.

For error monitoring with stack traces and grouping, see [Sentry](sentry.md) (optional, [sentry.io](https://sentry.io) Cloud).

## Quick start (Docker Compose)

Add Prometheus and Grafana to your deployment:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

This starts:

- **Prometheus** at `http://localhost:9090` — scrapes `transcriptor-mcp-api:3000/metrics`. The MCP compose service on `:4200` is **mcp-proxy** (no Node `/metrics` on that port unless you add a sidecar).
- **Grafana** at `http://localhost:3001` — login: `admin` / `admin` (change on first login)

The Grafana Prometheus datasource is provisioned automatically.

## Endpoints

| Service | Metrics | Failures list |
|---------|---------|---------------|
| REST API (port 3000) | `GET /metrics` | `GET /failures` |
| mcp-proxy on 4200 (stdio bridge) | — (use API or proxy metrics) | — |

## Available metrics

### REST API (`GET /metrics` on port 3000, `service=api`)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_requests_total` | Counter | method, route, status_code | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | method, route | Request latency |
| `http_request_errors_total` | Counter | — | Total 4xx/5xx responses |
| `cache_hits_total` | Counter | — | Cache hits |
| `cache_misses_total` | Counter | — | Cache misses |
| `subtitles_extraction_failures_total` | Counter | — | Videos where subtitles could not be obtained (neither YouTube nor Whisper) |
| `whisper_requests_total` | Counter | mode | Requests to Whisper (transcription attempts; mode=local or api) |
| `whisper_background_jobs_active` | Gauge | — | In-flight deduplicated background Whisper jobs |

### MCP tool metrics (in-process only; not HTTP-exported on the MCP image)

The MCP server updates `mcp_tool_calls_total`, `mcp_tool_errors_total`, and `mcp_request_duration_seconds` in code, but **without** a metrics HTTP endpoint on the MCP container these series are **not** available to Prometheus unless you add an exporter or fork the app. Listed for reference:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `mcp_tool_calls_total` | Counter | tool | Successful MCP tool calls |
| `mcp_tool_errors_total` | Counter | tool | Failed MCP tool calls |
| `mcp_request_duration_seconds` | Histogram | endpoint | Per-tool duration |

## Failures endpoint

`GET /failures` returns a JSON list of URLs where subtitle extraction failed (YouTube subtitles and Whisper fallback both returned nothing):

```json
{
  "failures": [
    { "url": "https://youtube.com/watch?v=xxx", "timestamp": "2025-02-13T12:00:00.000Z" }
  ],
  "total": 42
}
```

- Only records failures when Whisper fallback was enabled and attempted.
- Stores the last 100 failures per process in memory (reset on restart).

## PromQL examples

```
# Request rate (API)
rate(http_requests_total{service="api"}[5m])

# Error rate
rate(http_request_errors_total[5m])

# Latency p95 (API)
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service="api"}[5m]))

# Cache hit rate
rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))

# Subtitles extraction failures
increase(subtitles_extraction_failures_total[1h])

# Whisper requests (rate and total by mode)
rate(whisper_requests_total[5m])
increase(whisper_requests_total[1h])

# MCP tool calls (only if scraped from a process that exposes these series)
# rate(mcp_tool_calls_total[5m])
```

## Configuration

Prometheus scrape config is in `monitoring/prometheus.yml`. Grafana datasource is provisioned from `monitoring/grafana/provisioning/datasources/datasources.yml`.

For a custom setup (e.g. existing Prometheus), add scrape targets:

```yaml
scrape_configs:
  - job_name: 'transcriptor-mcp-api'
    static_configs:
      - targets: ['<api-host>:3000']
    metrics_path: /metrics
```

If you need HTTP-level metrics for **mcp-proxy**, configure your reverse proxy or run a sidecar; do not expect `/metrics` on port 4200 from this Node image unless you add that service yourself.
