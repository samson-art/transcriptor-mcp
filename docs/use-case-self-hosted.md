# Use case: Self-hosted and enterprise

Run Transcriptor MCP on your own infrastructure with optional authentication, Redis cache, Prometheus metrics, and Sentry — for teams that need control over data, rate limits, and monitoring.

## Who this is for

- **Teams** that require the MCP server (and optionally the REST API) to run on **your VPS, Tailscale, or private cloud**.
- You need **optional authentication** (Bearer token), **rate limiting**, and **audit-friendly** behavior.
- You want **observability**: Prometheus metrics, failure tracking, and optional Sentry for errors.

## Deployment options

- **Docker** (recommended): run **stdio MCP behind [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)** (and optionally the REST API) in containers; use `docker-compose.example.yml` for a full stack with Prometheus and Grafana.
- **Node.js**: build with `npm run build`, then `npm run start:mcp` for stdio and/or `npm start` for the API. For remote HTTP/SSE, run `mcp-proxy` in front of `node dist/mcp.js` as in [quick-start.mcp.md](quick-start.mcp.md).

For remote access (e.g. Cursor, Claude, n8n) use **HTTP/SSE** or **streamable HTTP** via **mcp-proxy** on a host reachable via your network (e.g. Tailscale) or reverse proxy.

## Authentication

- **MCP over HTTP/SSE:** mcp-proxy does not replace a full auth gateway. Terminate **TLS** and optional **Bearer** validation at a **reverse proxy** in front of mcp-proxy, or rely on a private network. See [quick-start.mcp.md](quick-start.mcp.md) for mcp-proxy flags (`--allow-origin`, etc.) and client header patterns.
- **REST API**: no built-in auth; put the API behind a reverse proxy (e.g. nginx, Cloudflare) with your own auth if needed.

Keep tokens and secrets in environment variables or a secret manager; do not commit them. See the main [README](https://github.com/samson-art/transcriptor-mcp#readme) Security section.

## Caching and performance

- **Redis:** Set `CACHE_MODE=redis` and `CACHE_REDIS_URL` to cache subtitles and metadata. Reduces yt-dlp calls and improves latency for repeated URLs. See [caching.md](caching.md).
- **Rate limiting:** For stdio + mcp-proxy, configure limits at your **reverse proxy** or cloud edge. Use yt-dlp sleep options (`YT_DLP_SLEEP_REQUESTS`, `YT_DLP_SLEEP_SUBTITLES`) to avoid platform throttling when running heavy batch jobs.

## Monitoring

### Prometheus metrics

The **REST API** (port 3000) exposes **GET /metrics** in Prometheus format (HTTP/cache/whisper/subtitle failures). **MCP tool counters** (`mcp_*`) are updated inside the MCP Node process but are **not** exposed over HTTP by this repository’s MCP image; use Sentry, logs, or proxy metrics for remote MCP, or run a custom exporter. Full detail: [monitoring.md](monitoring.md).

If you expose MCP via **stdio + mcp-proxy** on port 4200, that port is the proxy — it does not serve Node `/metrics`.

### Failures endpoint

- **GET /failures** on the REST API: JSON list of URLs where subtitle extraction failed (last 100 per process). Not exposed by mcp-proxy alone.

### Sentry (optional)

For error tracking with stack traces and grouping, configure Sentry via environment variables. The app uses `@sentry/node`; 5xx and 4xx can include request context and breadcrumbs. Details: [sentry.md](sentry.md).

## Quick reference: key docs

| Topic | Document |
|-------|----------|
| Env vars, auth, rate limits, yt-dlp, Redis | [configuration.md](configuration.md) |
| Prometheus, Grafana, /metrics, /failures, PromQL | [monitoring.md](monitoring.md) |
| Redis cache setup | [caching.md](caching.md) |
| Sentry setup | [sentry.md](sentry.md) |
| MCP Docker/Node/HTTP setup | [quick-start.mcp.md](quick-start.mcp.md) |

## See also

- [Researchers and batch processing](use-case-researchers-batch.md) — heavy use with playlists and search filters; self-host + Redis + monitoring.
- [n8n automation](use-case-n8n-automation.md) — connecting n8n to your self-hosted MCP server URL.
