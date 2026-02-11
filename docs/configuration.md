## Configuration and environment variables

This document describes the key environment variables and configuration options
for both the REST API and the MCP server.

> For basic startup examples, see:
> - `docs/quick-start.rest.md` (REST API)
> - `docs/quick-start.mcp.md` (MCP)

## Core server settings

- **`PORT`** – HTTP server port (default: `3000`)
- **`HOST`** – HTTP server host (default: `0.0.0.0`)

These are used by the Fastify REST API in `src/index.ts`.

## yt-dlp related settings

- **`YT_DLP_TIMEOUT`** – timeout for the yt-dlp command in milliseconds  
  - Default: `60000` (60 seconds)
- **`YT_DLP_JS_RUNTIMES`** – JS runtime(s) for yt-dlp extraction  
  - Examples: `node`, `node:/usr/bin/node`

These values are read in `src/youtube.ts` and passed to yt-dlp.

## Cookies file for restricted videos

- **`COOKIES_FILE_PATH`** – path to a `cookies.txt` file in Netscape format (optional)

This file is used when yt-dlp needs authenticated cookies to access:

- age-restricted videos
- sign-in required content
- region-locked videos

The application passes this path to yt-dlp via the `--cookies` flag.  
See `docs/cookies.md` for a detailed guide on:

- how to generate a `cookies.txt` file
- how to mount it in Docker / docker-compose
- how to configure it in local Node.js setups

## Rate limiting

The REST API uses `@fastify/rate-limit` to protect against abuse:

- **`RATE_LIMIT_MAX`** – maximum number of requests per time window  
  - Default: `100`
- **`RATE_LIMIT_TIME_WINDOW`** – time window for rate limiting  
  - Default: `1 minute`

These settings are applied in `src/index.ts` when registering the rate limit plugin.

## CORS (REST API)

- **`CORS_ALLOWED_ORIGINS`** – optional comma-separated list of allowed origins  
  - If unset or empty, all origins are allowed (`origin: true`)
  - Example: `https://app.example.com,https://admin.example.com`

Used in `src/index.ts` when registering the CORS plugin.

## Graceful shutdown

The server supports graceful shutdown with a configurable timeout:

- **`SHUTDOWN_TIMEOUT`** – timeout in milliseconds before forced exit  
  - Default: `10000` (10 seconds)

Used by the shutdown logic in `src/index.ts`.

## MCP server settings

For the MCP HTTP/SSE server (when using `npm run start:mcp:http` or the MCP Docker image):

- **`MCP_PORT`** – MCP HTTP server port (default often `4200`)
- **`MCP_HOST`** – MCP HTTP server host (default often `0.0.0.0`)

If you expose the MCP server remotely (e.g. on a VPS), you may also configure:

- **`MCP_AUTH_TOKEN`** – optional bearer token for protecting the MCP HTTP endpoint

Clients should then include:

```text
Authorization: Bearer <token>
```

in their requests.

- **`MCP_RATE_LIMIT_MAX`** – maximum requests per time window for MCP endpoints (default: `100`)
- **`MCP_RATE_LIMIT_TIME_WINDOW`** – time window for MCP rate limiting (default: `1 minute`)
- **`MCP_SESSION_TTL_MS`** – session TTL in milliseconds; sessions older than this are removed by cleanup (default: `3600000`, 1 hour)
- **`MCP_SESSION_CLEANUP_INTERVAL_MS`** – interval in milliseconds for cleaning expired MCP sessions (default: `900000`, 15 minutes)

The MCP HTTP server also supports **`SHUTDOWN_TIMEOUT`** for graceful shutdown (same as REST API).

## Health endpoint (REST API)

The REST API exposes **`GET /health`**, which returns `200` with `{ "status": "ok" }`. Use it for Kubernetes liveness/readiness or Docker `HEALTHCHECK`.

## Using .env files

For local development, you can use an `.env` file:

1. Copy the example:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` to adjust values such as:

   - `COOKIES_FILE_PATH=/absolute/path/to/cookies.txt`
   - `YT_DLP_TIMEOUT=120000`

Most process managers and tooling (e.g. `npm`, `docker-compose`, or dev environments)
can load this file automatically or via additional configuration.

## E2E smoke test

The project includes an e2e smoke test (`npm run test:e2e:api`) that starts Docker containers for the REST API and (optionally) the MCP server, then checks API endpoints and MCP transports (stdio, streamable HTTP at `/mcp`, SSE at `/sse`). See the main [README](../README.md#e2e-smoke-tests-rest-api--mcp-docker) for the list of env vars: `SMOKE_SKIP_MCP`, `SMOKE_MCP_IMAGE`, `SMOKE_MCP_PORT`, `SMOKE_MCP_URL`, `SMOKE_MCP_AUTH_TOKEN`, and the API-related `SMOKE_*` variables.

