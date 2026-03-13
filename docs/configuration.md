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
- **`YT_DLP_AUDIO_TIMEOUT`** – timeout for audio download only (Whisper fallback). Falls back to `YT_DLP_TIMEOUT` when unset. Use a higher value for long videos (e.g. 5 hours): at ~420 KiB/s, 5 h audio takes ~12 min; set `900000` (15 min) or more.
- **`YT_DLP_JS_RUNTIMES`** – JS runtime(s) for yt-dlp extraction  
  - Examples: `node`, `node:/usr/bin/node`
- **`YT_DLP_SKIP_VERSION_CHECK`** – if set to `1`, the app does not fetch the latest yt-dlp version from GitHub and does not log a WARNING when the installed version is older. The presence of yt-dlp in the system is still checked at startup.
- **`YT_DLP_REQUIRED`** – if set to `0`, the app logs an ERROR but does not exit when yt-dlp is missing or fails to run. Default behavior (unset or any other value) is to exit with code `1` when yt-dlp is not available.
- **`YT_DLP_PROXY`** – optional proxy URL for all yt-dlp requests (subtitle download, video info, chapters, audio for Whisper). Supported schemes: `http://`, `https://`, `socks5://`. Examples: `http://user:password@proxy.example.com:8080`, `socks5://127.0.0.1:9050` (e.g. Tor). If unset, yt-dlp runs without a proxy. In Docker, set this in the container `environment` if needed.
- **`YT_DLP_AUDIO_FORMAT`** – yt-dlp format selector for audio download (Whisper fallback). Default: `bestaudio[abr<=192]/bestaudio` (prefer streams ≤192 kbps to reduce download time; fallback to best audio). Keeps speech recognition quality while saving bandwidth.
- **`YT_DLP_AUDIO_QUALITY`** – `--audio-quality` value (0–9) when converting to m4a for Whisper. Default: `5` (~128 kbps VBR). Lower number = higher quality and larger file; 5 is a good balance for transcription.
- **`YT_DLP_MAX_FILESIZE`** – `--max-filesize` value (e.g. `50M`) for audio download (Whisper fallback). Aborts download if the file is larger than the specified size. Useful to avoid downloading very large videos when using Whisper.
- **`YT_DLP_DOWNLOAD_ARCHIVE`** – Path to an archive file for `get_playlist_transcripts`. When set, yt-dlp skips videos already in the archive (`--download-archive`) and stops on first existing (`--break-on-existing`). Requires persistent storage.
- **`YT_DLP_AGE_LIMIT`** – `--age-limit` value (e.g. `18`) for `search_videos`. Filters results by age rating.
- **`YT_DLP_NO_WARNINGS`** – if set to `1`, pass `--no-warnings` to all yt-dlp calls. Reduces log noise; may hide useful warnings (e.g. outdated extractor).
- **`YT_DLP_IGNORE_NO_FORMATS`** – when not set to `0`, pass `--ignore-no-formats-error` when fetching video metadata (video info, chapters, available subtitles). Allows returning metadata for region-locked or otherwise undownloadable videos. Set to `0` to fail on "No video formats" (default yt-dlp behavior).

**Retries and extra args (all yt-dlp calls):**

- **`YT_DLP_RETRIES`** – `-R` value (number or `infinite`). Default yt-dlp is 10. Increases retries for network flakiness.
- **`YT_DLP_RETRY_SLEEP`** – `--retry-sleep` value, e.g. `linear=1::2` or `exp=1:20`. Delay between retries.
- **`YT_DLP_EXTRA_ARGS`** – Space-separated extra arguments passed to all yt-dlp calls. For experts only; invalid values may break extraction.

**Sleep options (reduce rate limits):**

- **`YT_DLP_SLEEP_REQUESTS`** – Number of seconds to sleep between requests during extraction (`--sleep-requests`).
- **`YT_DLP_SLEEP_INTERVAL`** – Minimum seconds to sleep before each download (`--sleep-interval`).
- **`YT_DLP_MAX_SLEEP_INTERVAL`** – Maximum seconds to sleep (used with `YT_DLP_SLEEP_INTERVAL` for random range; `--max-sleep-interval`).
- **`YT_DLP_SLEEP_SUBTITLES`** – Seconds to sleep before each subtitle download (`--sleep-subtitles`). Useful for playlists.

**Subtitle format and encoding:**

- **`YT_DLP_SUB_FORMAT`** – Default subtitle format: `srt`, `vtt`, `ass`, or `lrc`. Can be overridden per request in MCP tools and REST API.
- **`YT_DLP_ENCODING`** – Character encoding for subtitle files, e.g. `utf-8`, `cp1251` (`--encoding`). Applied when downloading subtitles.

**Audio download options (Whisper fallback only):**

These apply only when downloading audio for Whisper. They improve reliability and speed for DASH/HLS streams:

- **`YT_DLP_AUDIO_CONCURRENT_FRAGMENTS`** – `-N` value. Number of DASH/HLS fragments downloaded in parallel (default 1). Try `4` or `8` on slow links.
- **`YT_DLP_AUDIO_LIMIT_RATE`** – `-r` value (e.g. `4M`, `500K`). Max download rate.
- **`YT_DLP_AUDIO_THROTTLED_RATE`** – `--throttled-rate` value. Min rate below which throttling is assumed and extraction retried.
- **`YT_DLP_AUDIO_RETRIES`** – `-R` value for audio download.
- **`YT_DLP_AUDIO_FRAGMENT_RETRIES`** – `--fragment-retries` value for DASH/HLS fragments.
- **`YT_DLP_AUDIO_RETRY_SLEEP`** – `--retry-sleep` value for audio download.
- **`YT_DLP_AUDIO_BUFFER_SIZE`** – `--buffer-size` value (e.g. `64K`).
- **`YT_DLP_AUDIO_HTTP_CHUNK_SIZE`** – `--http-chunk-size` value. Experimental; may bypass server throttling.
- **`YT_DLP_AUDIO_DOWNLOADER`** – `--downloader` value (e.g. `aria2c`).
- **`YT_DLP_AUDIO_DOWNLOADER_ARGS`** – `--downloader-args` value (e.g. `aria2c:"-x 4 -k 1M"`).

These values are read in `src/youtube.ts` and passed to yt-dlp (timeout, runtimes, proxy, audio format/quality). The app always passes `--quiet` and `--no-progress` to all yt-dlp calls for cleaner headless/server logs. Startup checks are implemented in `src/yt-dlp-check.ts`.

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

**Public base URL for SSE endpoint:** When the MCP server is used from another origin (e.g. Smithery.ai auth popup), the SSE transport must advertise the full message URL in the `endpoint` event so clients POST to the correct server. Configure one of:

- **`MCP_PUBLIC_URL`** – optional single public base URL. When set, the SSE transport sends the full message URL in the endpoint event.
- **`MCP_PUBLIC_URLS`** – optional comma-separated list of public base URLs for multi-origin deployments. The server picks the matching URL from the request's `Host` or `X-Forwarded-Host` header. If both are set, `MCP_PUBLIC_URLS` takes precedence.

The MCP HTTP server also supports **`SHUTDOWN_TIMEOUT`** for graceful shutdown (same as REST API).

## Whisper fallback (subtitles not available)

When subtitles cannot be obtained from YouTube (via yt-dlp), the app can optionally use [Whisper](https://github.com/openai/whisper) to transcribe the video audio. Configure via environment variables:

- **`WHISPER_MODE`** – when to use Whisper  
  - `off` (default) – no fallback; return 404 when subtitles are missing  
  - `local` – use a self-hosted Whisper HTTP service (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) in a Docker container)  
  - `api` – use an OpenAI-compatible transcription API (e.g. OpenAI Whisper API)

**For local Whisper** (e.g. container `whisper:9000`):

- **`WHISPER_BASE_URL`** – base URL of the Whisper service (e.g. `http://whisper:9000`)
- **`WHISPER_TIMEOUT`** – request timeout in milliseconds (default: `600000`, 10 min). For 1-hour videos on CPU, set 30–60 minutes (e.g. `3600000`); for 5-hour videos, use `3600000` (1 h) or more.

Local mode is compatible with [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice): the app sends `POST /asr` with the audio file in the `audio_file` form field and query parameters `output` (srt, vtt, or txt) and optional `language`.

**For Whisper API** (OpenAI or compatible):

- **`WHISPER_API_KEY`** – API key (required when `WHISPER_MODE=api`); never logged
- **`WHISPER_API_BASE_URL`** – base URL (default: `https://api.openai.com/v1`) for custom endpoints

Flow: the app downloads audio with yt-dlp (using format `bestaudio[abr<=192]/bestaudio` and `--audio-quality 5` by default to reduce download size and time without hurting speech recognition), sends it to Whisper, and returns the transcript as subtitles (SRT/VTT or plain text). Long videos may hit API size limits (e.g. OpenAI 25 MB); failures are logged and the client receives a "Subtitles not found" response that explicitly mentions Whisper failure when applicable. For 1-hour videos on CPU, set `WHISPER_TIMEOUT=3600000` (30–60 min). For videos up to 5 hours: use `YT_DLP_AUDIO_TIMEOUT=900000`, `WHISPER_TIMEOUT=3600000`, and **local Whisper** only (API mode cannot accept files >25 MB).

**Docker on Mac:** GPU is not available inside Docker (the Linux VM has no access to the host GPU). To speed up local Whisper on a MacBook, use a smaller model in the Whisper service (e.g. `ASR_MODEL=tiny` in the container env) or run Whisper natively with Metal support and point `WHISPER_BASE_URL` to that service.

**Container memory limits:** For long videos, Whisper on CPU can use several GB of RAM. Without an explicit limit, the host OOM killer may terminate the container. Set `deploy.resources.limits.memory` (or `mem_limit` in older Compose) so the container has a predictable, sufficient allocation (e.g. 4–6 GB for 1-hour transcriptions). Example:

```yaml
whisper:
  image: onerahmet/openai-whisper-asr-webservice:latest
  deploy:
    resources:
      limits:
        memory: 6G
  environment:
    ASR_ENGINE: openai_whisper
    ASR_MODEL: base
```

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

## Recommended values for production

| Variable | Suggested | Notes |
|----------|-----------|--------|
| `RATE_LIMIT_MAX` | `200`–`1000` | Depends on traffic; raise if load tests or real usage hit the limit. |
| `YT_DLP_TIMEOUT` | `60000`–`90000` | 60–90 s; long videos may need more. |
| `SHUTDOWN_TIMEOUT` | `10000` | 10 s usually enough for in-flight requests. |
| `CACHE_TTL_SUBTITLES_SECONDS` | `604800` | 7 days; subtitles rarely change. |
| `CACHE_TTL_METADATA_SECONDS` | `3600` | 1 hour for info/available/chapters. |
| `CACHE_MODE` | `redis` | Use Redis when you want to reduce yt-dlp load. |

## Health and metrics (REST API)

- **`GET /health`** – returns `200` with `{ "status": "ok" }`. Use it for Kubernetes liveness or Docker `HEALTHCHECK` (no dependency checks).
- **`GET /health/ready`** – readiness check. Returns `200` when the app is ready to serve traffic. When `CACHE_MODE=redis`, it pings Redis; if Redis is unreachable, returns `503` with `{ "status": "not ready", "redis": "unreachable" }`. Use for Kubernetes readiness so the pod is not sent traffic until Redis is available.
- **`GET /metrics`** – Prometheus text exposition format. See [Monitoring](monitoring.md) for full metric list.
- **`GET /failures`** – JSON list of URLs where subtitle extraction failed (YouTube + Whisper both failed).

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

For local overrides with sensitive values (e.g. `COOKIES_FILE_PATH`, `WHISPER_API_KEY`, `CACHE_REDIS_URL`, `MCP_AUTH_TOKEN`), copy `.env.local.example` to `.env.local` and fill in the values. The `.env.local` file is gitignored; do not commit real credentials.

## E2E smoke test

The project includes an e2e smoke test (`npm run test:e2e:api`) that starts Docker containers for the REST API and (optionally) the MCP server, then checks API endpoints and MCP transports (stdio, streamable HTTP at `/mcp`, SSE at `/sse`). See the main [README](../README.md#e2e-smoke-tests-rest-api--mcp-docker) for the list of env vars: `SMOKE_SKIP_MCP`, `SMOKE_MCP_IMAGE`, `SMOKE_MCP_PORT`, `SMOKE_MCP_URL`, `SMOKE_MCP_AUTH_TOKEN`, and the API-related `SMOKE_*` variables.

