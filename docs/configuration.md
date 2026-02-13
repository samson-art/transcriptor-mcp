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
- **`YT_DLP_SKIP_VERSION_CHECK`** – if set to `1`, the app does not fetch the latest yt-dlp version from GitHub and does not log a WARNING when the installed version is older. The presence of yt-dlp in the system is still checked at startup.
- **`YT_DLP_REQUIRED`** – if set to `0`, the app logs an ERROR but does not exit when yt-dlp is missing or fails to run. Default behavior (unset or any other value) is to exit with code `1` when yt-dlp is not available.
- **`YT_DLP_PROXY`** – optional proxy URL for all yt-dlp requests (subtitle download, video info, chapters, audio for Whisper). Supported schemes: `http://`, `https://`, `socks5://`. Examples: `http://user:password@proxy.example.com:8080`, `socks5://127.0.0.1:9050` (e.g. Tor). If unset, yt-dlp runs without a proxy. In Docker, set this in the container `environment` if needed.

These values are read in `src/youtube.ts` and passed to yt-dlp (timeout, runtimes, proxy). Startup checks are implemented in `src/yt-dlp-check.ts`.

## Cookies file for restricted videos

- **`COOKIES_FILE_PATH`** – path to a `cookies.txt` file in Netscape format (optional)

This file is used when yt-dlp needs authenticated cookies to access:

- age-restricted videos
- sign-in required content
- region-locked videos

Some of the other supported platforms (e.g. Twitter/X, Instagram, VK) may also require cookies for certain content; the same `COOKIES_FILE_PATH` is passed to yt-dlp for all URLs.

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

## Whisper fallback (subtitles not available)

When subtitles cannot be obtained from YouTube (via yt-dlp), the app can optionally use [Whisper](https://github.com/openai/whisper) to transcribe the video audio. Configure via environment variables:

- **`WHISPER_MODE`** – when to use Whisper  
  - `off` (default) – no fallback; return 404 when subtitles are missing  
  - `local` – use a self-hosted Whisper HTTP service (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) in a Docker container)  
  - `api` – use an OpenAI-compatible transcription API (e.g. OpenAI Whisper API)

**For local Whisper** (e.g. container `whisper:9000`):

- **`WHISPER_BASE_URL`** – base URL of the Whisper service (e.g. `http://whisper:9000`)
- **`WHISPER_TIMEOUT`** – request timeout in milliseconds (default: `120000`)

Local mode is compatible with [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice): the app sends `POST /asr` with the audio file in the `audio_file` form field and query parameters `output` (srt, vtt, or txt) and optional `language`.

**For Whisper API** (OpenAI or compatible):

- **`WHISPER_API_KEY`** – API key (required when `WHISPER_MODE=api`); never logged
- **`WHISPER_API_BASE_URL`** – base URL (default: `https://api.openai.com/v1`) for custom endpoints

Flow: the app downloads audio with yt-dlp, sends it to Whisper, and returns the transcript as subtitles (SRT/VTT or plain text). Long videos may hit API size limits (e.g. OpenAI 25 MB); failures are logged and the client receives the same "Subtitles not found" response as when Whisper is disabled.

**Docker on Mac:** GPU is not available inside Docker (the Linux VM has no access to the host GPU). To speed up local Whisper on a MacBook, use a smaller model in the Whisper service (e.g. `ASR_MODEL=tiny` in the container env) or run Whisper natively with Metal support and point `WHISPER_BASE_URL` to that service.

## Cache (Redis)

Responses for subtitles, video info, available subtitles, and chapters can be cached in Redis so repeated requests for the same video are served without calling yt-dlp again. Both the REST API and the MCP server use this cache when it is enabled.

- **`CACHE_MODE`** – cache mode  
  - `off` (default) – no caching; every request hits yt-dlp  
  - `redis` – use Redis as cache backend (requires `CACHE_REDIS_URL`)

- **`CACHE_REDIS_URL`** – Redis connection URL (required when `CACHE_MODE=redis`)  
  - Example: `redis://localhost:6379`

- **`CACHE_TTL_SUBTITLES_SECONDS`** – TTL in seconds for successfully fetched subtitles (YouTube or Whisper)  
  - Default: `604800` (7 days). Subtitles rarely change, so a long TTL is safe.

- **`CACHE_TTL_METADATA_SECONDS`** – TTL in seconds for video metadata: video info, available subtitles list, and chapters  
  - Default: `3600` (1 hour). Metadata (title, views, available languages) can change, so a shorter TTL is used.

If `CACHE_MODE=redis` is set but `CACHE_REDIS_URL` is missing, the app logs a warning and runs with cache disabled.

See [`docs/caching.md`](caching.md) for a short overview of what is cached and example env.

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

