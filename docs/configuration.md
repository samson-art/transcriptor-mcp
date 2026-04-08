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
- **`YT_DLP_PLAYLIST_IGNORE_ERRORS`** – For `get_playlist_transcripts` only. When unset or any value other than `0`, yt-dlp receives `--ignore-errors` so one bad playlist entry does not abort the whole run. Set to `0` to omit this flag (stop on first error).
- **`YT_DLP_VERBOSE_ON_ERROR`** – When set to `1`, after a failed playlist subtitle download the app runs yt-dlp once more with `-v` and without `--quiet`/`--no-progress`, and logs stderr (diagnostics only; the tool still fails if no subtitle files were written).
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

**Deployment models:**

1. **stdio** (`npm run start:mcp` / default Docker `CMD`) — use for local Cursor/Claude or as the child process behind [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).
2. **Remote HTTP/SSE** — run stdio behind **mcp-proxy**; listen address and CORS come from **mcp-proxy** flags (`--port`, `--host`, `--allow-origin`, …). See [quick-start.mcp.md](quick-start.mcp.md) for install (pinned version), run commands, client URLs (Cursor / Claude / n8n), and how a conceptual **`MCP_AUTH_TOKEN`** maps to Bearer at the **proxy**, not in Node.

There is **no** in-process HTTP/SSE MCP server in this repository; Bearer protection, rate limits, and canonical public URLs for hosted catalogs are handled at your **reverse proxy**, **cloud edge**, or **mcp-proxy**-compatible tooling—not via `MCP_*` HTTP variables on the Node app.

The stdio MCP process still honors **`SHUTDOWN_TIMEOUT`** (and other app env vars such as Whisper and cache) the same way as the REST API; pass them to the Node process (e.g. `mcp-proxy --pass-environment` or `-e` per upstream docs).

## Whisper fallback (subtitles not available)

You can enable Whisper fallback to transcribe audio when subtitles are unavailable. When subtitles cannot be obtained (via yt-dlp), the app can optionally use [Whisper](https://github.com/openai/whisper) to transcribe the video audio. Configure via environment variables:

- **`WHISPER_MODE`** – when to use Whisper  
  - `off` (default) – no fallback; return 404 when subtitles are missing  
  - `local` – use a self-hosted Whisper HTTP service (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) in a Docker container)  
  - `api` – use an OpenAI-compatible transcription API (e.g. OpenAI Whisper API)

**For local Whisper** (e.g. container `whisper:9000`):

- **`WHISPER_BASE_URL`** – base URL of the Whisper service (e.g. `http://whisper:9000`)
- **`WHISPER_TIMEOUT`** – per-request wait in milliseconds (default: `600000`, 10 min): how long the API waits for Whisper before returning “Subtitles not found” to the client. Long transcription can still finish in the background and be written to Redis (when `CACHE_MODE=redis`); see **`WHISPER_BACKGROUND_TIMEOUT`**. For 1-hour videos on CPU, set 30–60 minutes (e.g. `3600000`); for 5-hour videos, use `3600000` (1 h) or more.

- **`WHISPER_BACKGROUND_TIMEOUT`** – max time in milliseconds for the **deduplicated background** Whisper HTTP call (default: `max(1800000, 3 × WHISPER_TIMEOUT)` — at least 30 minutes). Set to `0` to disable the client-side abort on that call (not recommended unless you trust your Whisper service). Shorter than `WHISPER_TIMEOUT` is allowed but usually pointless.

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

You can optionally enable Redis caching to reduce repeated yt-dlp calls. Responses for subtitles, video info, available subtitles, and chapters can be cached in Redis so repeated requests for the same video are served without calling yt-dlp again. Both the REST API and the MCP server use this cache when it is enabled.

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

