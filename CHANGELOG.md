# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.7] - 2026-02-13

### Added

- **CI (GitHub Actions):** `.github/workflows/ci.yml` runs on push/PR to `main`: `npm ci`, `make check-no-smoke` (format-check, lint, typecheck, test, build). On push to `main`, optional smoke job runs REST API smoke with `SMOKE_SKIP_MCP=1`. `.github/workflows/publish-docker.yml` runs on tag push `v*`: build and push REST API and MCP images to Docker Hub (multi-arch linux/amd64, linux/arm64). Requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets.
- **Readiness and metrics (REST API):** `GET /health/ready` — when `CACHE_MODE=redis`, pings Redis; returns 503 if Redis is unreachable (for Kubernetes readiness). `GET /metrics` — Prometheus text format with counters: `http_requests_total`, `http_request_errors_total`, `cache_hits_total`, `cache_misses_total`. New `src/metrics.ts`; validation layer records cache hit/miss; REST error handler and onResponse hook record errors and requests.
- **Cache:** `cache.ping()` in `src/cache.ts` for Redis liveness. Unit tests for `ping()` when cache off and when Redis URL unset.
- **Documentation:** README — repo/package name note (yt-captions-downloader vs transcriptor-mcp), Versioning subsection (version from package.json, tagging), Security section (do not commit or log `WHISPER_API_KEY`, `CACHE_REDIS_URL`, `MCP_AUTH_TOKEN`, cookies path; use env or secret manager). `docs/configuration.md` — Health and metrics (health, health/ready, metrics), Recommended values for production table. `docs/caching.md` — section “When Redis is unavailable” (graceful degradation: request still served via yt-dlp).
- **E2E smoke:** MCP streamable HTTP smoke now includes `checkMcpStreamableGetTranscript`: after initialize, calls `tools/call` for `get_transcript` and asserts content or structuredContent. `load/load-testing.md` — “Recommended thresholds for regression” (e.g. `http_req_failed` rate<0.05, p95<120s; `k6 run --throw` for CI).
- **Pre-commit (Husky):** `husky` devDependency and `prepare` script; `.husky/pre-commit` runs `npm run format-check && npm run lint`.
- **verify-pool script:** `npm run verify-pool` (and Make target) runs `load/verify-pool.js` to validate the k6 load-test video ID pool.

### Changed

- **Graceful shutdown:** REST API (`src/index.ts`) and MCP HTTP (`src/mcp-http.ts`) now call `closeCache()` after closing the server so the Redis connection is closed cleanly.
- **yt-dlp-check:** Fallback logger uses `console.warn` instead of `console.info` for the info-level message to satisfy the no-console lint rule.
- **Dependencies:** Bumped Fastify plugins (`@fastify/cors` ^11.2.0, `@fastify/multipart` ^9.4.0, `@fastify/rate-limit` ^10.3.0, `@fastify/swagger` ^9.7.0, `@fastify/swagger-ui` ^5.2.5, `@fastify/type-provider-typebox` ^6.1.0), `@sinclair/typebox` ^0.34.48, `ioredis` ^5.9.3. Dev: `@types/jest` ^30.0.0, `@types/node` ^25.2.3, `@typescript-eslint/*` and `typescript-eslint` ^8.55.0, `eslint` ^9.18.0, `jest` ^30.2.0, `prettier` ^3.8.1, `ts-jest` ^29.4.6, `typescript` ^5.9.3, `husky` ^9.1.7.

## [0.4.6] - 2026-02-13

### Added

- **Optional Redis cache:** Responses for subtitles, video info, available subtitles, and chapters can be cached in Redis to reduce repeated yt-dlp calls. Configure via env: `CACHE_MODE` (`off` or `redis`), `CACHE_REDIS_URL` (required when `redis`), `CACHE_TTL_SUBTITLES_SECONDS` (default 7 days for subtitles), `CACHE_TTL_METADATA_SECONDS` (default 1 hour for video info, available subtitles, chapters). New `src/cache.ts` with `getCacheConfig()`, `get()`, `set()`, `close()`. Both REST API and MCP use the cache when enabled. Documented in `docs/caching.md`, `docs/configuration.md`, and `.env.example`.
- **MCP uses validation layer:** MCP tools now call `validateAndDownloadSubtitles`, `validateAndFetchAvailableSubtitles`, `validateAndFetchVideoInfo`, and `validateAndFetchVideoChapters` instead of calling youtube/whisper directly, so MCP benefits from the same cache and validation as the REST API. Removed private `fetchSubtitlesContent` from `mcp-core.ts`; tools catch `ValidationError` and `NotFoundError` and return tool errors.
- **Unit tests:** `cache.test.ts` for `getCacheConfig` (mode, TTLs from env), get/set when `CACHE_MODE=off`, and `close()`. `validation.test.ts` mocks `./cache.js` so existing tests run with cache disabled. `mcp-core.test.ts` updated to mock validation’s validateAnd* and expect corresponding calls.

### Changed

- **Dependency:** Added `ioredis` for Redis cache backend (used only when `CACHE_MODE=redis`).

## [0.4.5] - 2026-02-13

### Added

- **REST/MCP error types:** `src/errors.ts` exports `HttpError`, `ValidationError`, and `NotFoundError` with status codes and error labels. Validation helpers throw these; REST global error handler maps them to 4xx/5xx and consistent JSON (`error`, `message`).
- **MCP HTTP auth module:** `src/mcp-auth.ts` provides `ensureAuth(request, reply, authToken)` and `getHeaderValue()`; MCP HTTP server uses them when `MCP_AUTH_TOKEN` is set. Token comparison is timing-safe to prevent timing attacks.
- **Unit tests:** `mcp-auth.test.ts` for `getHeaderValue` and `ensureAuth` (no auth, missing/ malformed Bearer, wrong token, correct token). `mcp-http.test.ts` for 401 on `/mcp` when auth required and no/ invalid header, and that `/health` remains allowed without auth when token is set.
- **Load testing:** `docs/load-testing.md` documents k6-based load tests for the REST API (health, subtitles, mixed). Make targets: `load-test`, `load-test-health`, `load-test-subtitles`, `load-test-mixed` (Docker k6); npm scripts: `load-test`, `load-test:subtitles`, `load-test:mixed`. Configurable via `LOAD_BASE_URL` / `BASE_URL` and `RATE_LIMIT_MAX` for throughput.

### Changed

- **MCP:** Shared logic for subtitle fetch and Whisper fallback is now in a private `fetchSubtitlesContent(resolved, log)` in `mcp-core.ts`. Tools `get_transcript` and `get_raw_subtitles` call it and only handle final processing (parse + paginate vs raw + paginate). Removes duplication of `resolveSubtitleArgs`, `downloadSubtitles`, and Whisper fallback between the two tools.
- **Docker: single Dockerfile with shared base.** One Dockerfile now builds both REST API and MCP images via multi-stage build. Stages: `builder` (Node, npm ci, build) → `base` (node, python3, pip, curl, unzip, ffmpeg, Deno, yt-dlp -U, YT_DLP_JS_RUNTIMES) → `api` (REST, port 3000) and `mcp` (MCP, port 4200). Build with `docker build -f Dockerfile --target api .` or `--target mcp .`. `Dockerfile.mcp` removed; Makefile targets `docker-build-api` and `docker-build-mcp` (and buildx variants) use the same Dockerfile with the appropriate target. README and `docs/quick-start.mcp.md` updated to use `--target api` / `--target mcp`.

### Security

- **MCP HTTP auth:** Bearer token validation uses `crypto.timingSafeEqual` so comparison time does not depend on the token value.

## [0.4.4] - 2026-02-13

### Changed

- **Chapters: single yt-dlp fetch.** `validateAndFetchVideoChapters` (REST `/video-info/chapters`) and MCP tool `get_video_chapters` now perform one yt-dlp network call instead of two. `fetchVideoChapters` in `youtube.ts` accepts an optional third argument `preFetchedData`; when provided, it reuses that data and skips the internal `fetchYtDlpJson` call. Validation and MCP handlers fetch once and pass the result into `fetchVideoChapters`, so video ID and chapters are derived from the same response.

### Added

- **Export:** `YtDlpVideoInfo` type is now exported from `youtube.ts` for callers that pass pre-fetched data into `fetchVideoChapters`.
- **Unit tests:** `youtube.test.ts` — `fetchVideoChapters` with `preFetchedData` (no execFile call, correct chapter mapping; null handling). `validation.test.ts` — `fetchYtDlpJson` called once and data passed to `fetchVideoChapters`; Vimeo test expects three-argument call. `mcp-core.test.ts` — chapters tool expectations updated for fetch order and three-argument `fetchVideoChapters` call.

## [0.4.3] - 2026-02-13

### Added

- **yt-dlp proxy (optional):** All yt-dlp requests (subtitle download, video info, chapters, audio for Whisper) can be routed through a proxy. Set `YT_DLP_PROXY` to a URL; supported schemes: `http://`, `https://`, `socks5://` (e.g. `http://user:password@proxy.example.com:8080`, `socks5://127.0.0.1:9050` for Tor). Documented in `docs/configuration.md` and `.env.example`; in Docker, set the variable in the container `environment` if needed.

### Changed

- **Unit tests:** `youtube.test.ts` — `getYtDlpEnv` and `appendYtDlpEnvArgs` now cover `YT_DLP_PROXY` / `proxyFromEnv` (trim, presence of `--proxy` in args, omission when unset).

## [0.4.2] - 2026-02-13

### Changed

- **MCP tools `get_transcript` and `get_raw_subtitles`:** Parameter `lang` is now optional. When omitted, subtitle download still uses `en` for yt-dlp; when Whisper fallback is used, language is auto-detected (no `language` query param sent to Whisper). Tool descriptions updated to mention optional `lang` and auto-detect behavior.

### Added

- **Unit tests:** `mcp-core.test.ts` — Whisper fallback with omitted `lang` (auto-detect). `whisper.test.ts` — no `language` param when `lang` is empty.

## [0.4.1] - 2026-02-12

### Added

- **yt-dlp cookies file logging:** When `COOKIES_FILE_PATH` is set, the app now logs cookies file status before each yt-dlp call (subtitle download, audio download, video info/chapters). Logs include path, existence, file size, or access error message (no cookie contents). Helps diagnose "Sign in to confirm you're not a bot" and other YouTube auth issues when running in Docker or with mounted cookies.

## [0.4.0] - 2026-02-12

### Changed

- **Project rename:** `yt-captions-downloader` → `transcriptor-mcp`. Package name, GitHub repo, Docker images, and docker-compose service names have been updated.
- **Package:** `transcriptor-mcp` (was `yt-captions-downloader-mcp`).
- **GitHub:** `samson-art/transcriptor-mcp`.
- **Docker images:** `artsamsonov/transcriptor-mcp` (MCP), `artsamsonov/transcriptor-mcp-api` (REST API).
- **docker-compose services:** `transcriptor-mcp` (MCP), `transcriptor-mcp-api` (REST API).
- **MCP server name:** `transcriptor-mcp` (reported in MCP initialize).
- **User-Agent:** `transcriptor-mcp` (for yt-dlp requests).
- **MCP config key:** Use `transcriptor` in `claude_desktop_config.json` / Cursor MCP settings (shorter UX).

## [0.3.8] - 2026-02-12

### Added

- **Multi-platform support:** Subtitles, available subtitles, video info, and chapters work with URLs from YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, and Dailymotion (via yt-dlp). Bare video IDs are supported for YouTube only.
- **Whisper fallback:** When YouTube subtitles cannot be obtained (yt-dlp returns none), the app can transcribe video audio via Whisper. Configurable with `WHISPER_MODE` (`off`, `local`, `api`). Local mode uses a self-hosted HTTP service (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) in Docker); API mode uses an OpenAI-compatible transcription endpoint. New env vars: `WHISPER_BASE_URL`, `WHISPER_TIMEOUT`, `WHISPER_API_KEY`, `WHISPER_API_BASE_URL`. REST responses for `/subtitles` and `/subtitles/raw` include optional `source: "youtube" | "whisper"`; MCP tools `get_transcript` and `get_raw_subtitles` use the same fallback and expose `source` in structured content.
- **Audio download:** `downloadAudio(videoId, logger)` in `youtube.ts` downloads audio-only via yt-dlp for Whisper input; uses same cookies and timeout as subtitle download.
- **Docker:** `docker-compose.example.yml` adds a `whisper` service (image `onerahmet/openai-whisper-asr-webservice:latest`) and example `WHISPER_*` env for `transcriptor-mcp-api` and `transcriptor-mcp`. `.env.example` and `docs/configuration.md` document all Whisper options.
- **Unit tests:** `src/whisper.test.ts` for `getWhisperConfig` and `transcribeWithWhisper`; `validation.test.ts` extended with Whisper fallback success and 404 when Whisper returns null.
- **yt-dlp startup check:** REST API, MCP HTTP, and MCP stdio servers run a yt-dlp availability check at startup. If yt-dlp is missing or fails to run, the app logs an ERROR and exits (unless `YT_DLP_REQUIRED=0`). If the installed version is older than the latest on GitHub, a WARNING is logged.
- **Environment variables:** `YT_DLP_SKIP_VERSION_CHECK` — when set to `1`, skips the GitHub version check and WARNING; `YT_DLP_REQUIRED` — when set to `0`, logs ERROR but does not exit when yt-dlp is missing or fails.
- **Unit tests:** `src/yt-dlp-check.test.ts` for version parsing, comparison, GitHub fetch, and startup check behavior.

### Changed

- `docs/configuration.md`: Documented `YT_DLP_SKIP_VERSION_CHECK` and `YT_DLP_REQUIRED`; startup checks reference `src/yt-dlp-check.ts`. Added "Whisper fallback" section for all `WHISPER_*` variables and usage (local container vs API).

## [0.3.7] - 2026-02-11

### Added

- **REST API:** `GET /health` endpoint returning `{ "status": "ok" }` for liveness/readiness and Docker `HEALTHCHECK`.
- **REST API:** Optional CORS allowlist via `CORS_ALLOWED_ORIGINS` (comma-separated origins); when unset, all origins remain allowed.
- **MCP HTTP server:** Rate limiting configurable via `MCP_RATE_LIMIT_MAX` and `MCP_RATE_LIMIT_TIME_WINDOW`.
- **MCP HTTP server:** Session TTL and periodic cleanup via `MCP_SESSION_TTL_MS` and `MCP_SESSION_CLEANUP_INTERVAL_MS`.
- **Version:** `src/version.ts` reads version from `package.json`; REST API and MCP server use it for responses and server info.
- **E2E smoke test:** MCP coverage — starts MCP container and verifies stdio (initialize over stdin/stdout), streamable HTTP (`POST /mcp`), and SSE (`GET /sse`). New env vars: `SMOKE_SKIP_MCP`, `SMOKE_MCP_IMAGE`, `SMOKE_MCP_URL` / `SMOKE_MCP_PORT`, `SMOKE_MCP_AUTH_TOKEN`, plus API-related overrides.
- **Docs:** `docs/configuration.md` — CORS, MCP rate limit/session/cleanup, health endpoint, and E2E smoke test env vars. `.env.example` updated with `CORS_ALLOWED_ORIGINS` and MCP HTTP options.

### Changed

- REST API and MCP server now derive version from `package.json` instead of hardcoded values.
- REST API: global Fastify error handler returns 500 with `error` and `message`; route handlers no longer wrap in try/catch so validation/parsing errors are handled consistently.
- E2E smoke test flow: single entry `npm run test:e2e:api` with optional MCP checks; README updated with env var table and simplified run instructions.
- `docker-compose.example.yml`: reordered keys (ports after environment), added `restart: unless-stopped` for MCP service; API service no longer includes `build` (image-only).
- Jest: exclude `src/e2e/api-smoke.ts` from coverage (top-level await).

## [0.3.6] - 2026-02-05

### Changed

- Upgraded Fastify to v5 and related plugins (`@fastify/cors`, `@fastify/multipart`, `@fastify/rate-limit`, `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/type-provider-typebox`) to compatible major versions.
- Bumped `@modelcontextprotocol/sdk` to ^1.26.0.

## [0.3.5] - 2026-02-04

### Added

- OpenAPI/Swagger documentation at `/docs` with request/response schemas for all REST endpoints (subtitles, raw subtitles, available subtitles, video info, chapters).
- E2E smoke test now verifies that Swagger UI at `/docs` is reachable.

### Changed

- REST routes registered with `@fastify/swagger` and `@fastify/swagger-ui`; each endpoint documents body and response schemas for generated OpenAPI spec.

## [0.3.4] - 2026-02-04

### Added

- Docker-based e2e smoke test for the REST API (`src/e2e/api-smoke.ts`) that builds a local image, starts a container and verifies `POST /subtitles` against a real YouTube video.
- Documentation in `README` for running Docker smoke tests locally and as part of the `make publish` workflow.
- Additional unit tests for validation helpers and yt-dlp integration (URL / video ID / language sanitization, video info and chapter extraction, environment-driven yt-dlp flags).
- Dedicated test suite for MCP tools (`src/mcp-core.test.ts`) covering success and error paths for transcripts, raw subtitles, available subtitles, video info and chapters.

### Changed

- Hardened `validation.ts` helpers to provide more explicit 4xx errors for invalid URLs, video IDs and language codes across subtitles, available subtitles, video info and chapters endpoints.
- Improved `youtube.ts` helpers to map more yt-dlp metadata, expose chapter markers, and sort official vs auto subtitle language codes for stable output.
- Refined MCP core implementation to use stricter validation and add pagination/error handling tests for all tools.
- Updated Jest configuration to collect coverage from `src`, exclude entrypoints (REST + MCP) and enable verbose output.

## [0.3.3] - 2026-02-04

### Added

- New `/subtitles/available` REST endpoint that returns the video ID and sorted lists of official vs auto-generated subtitle language codes.
- Validation helper `validateAndFetchAvailableSubtitles` for safely extracting and sanitizing YouTube video IDs before fetching available subtitles.
- Unit test `fetchAvailableSubtitles.test.ts` covering `fetchAvailableSubtitles` behavior (official vs auto subtitles).
- Documentation for using the MCP server as an n8n MCP client over streamable HTTP, including guidance on `N8N_PROXY_HOPS`.

### Changed

- Production `Dockerfile` now installs Deno as a JS runtime for `yt-dlp`, updates `yt-dlp` to the latest stable release, and configures `YT_DLP_JS_RUNTIMES="deno,node"`.
- MCP core now imports Zod via `zod/v3` to improve JSON Schema compatibility with strict MCP clients (such as n8n).
- Jest configuration adds a `moduleNameMapper` rule to map `.js` imports back to TypeScript sources under NodeNext/ESM.
- Updated API documentation in `README` to cover the new `/subtitles/available` endpoint with request/response examples.
- Updated `.gitignore` to also ignore `Makefile`.

## [0.3.1] - 2026-02-03

### Added

- MCP server over HTTP transports:
  - Streamable HTTP endpoint at `/mcp` (`src/mcp-http.ts`)
  - SSE endpoint at `/sse` with message handler at `/message` (`src/mcp-http.ts`)
- Optional auth for HTTP MCP via `MCP_AUTH_TOKEN` (Bearer token)
- Optional SSE allowlists via `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS`
- Extracted reusable MCP server core into `src/mcp-core.ts`
- New script: `start:mcp:http`

### Changed

- Updated `docker-compose.example.yml` MCP service to run HTTP mode and expose port `4200`
- Updated `Dockerfile.mcp` to expose `4200` for HTTP mode
- Streamlined `src/mcp.ts` to be stdio-only entrypoint
- Bumped package version to `0.3.1`

## [0.3.0] - 2026-02-03

### Added

- MCP server (Cursor) over stdio (`src/mcp.ts`) with tools:
  - `get_transcript` (plain text transcript, paginated)
  - `get_raw_subtitles` (raw SRT/VTT, paginated)
  - `get_available_subtitles` (official vs auto language codes)
  - `get_video_info` (basic metadata via yt-dlp)
- Docker image for MCP server (`Dockerfile.mcp`)
- `docker-compose.example.yml` with an additional MCP service example
- `REPOSITORY_OVERVIEW.md` project overview document

### Changed

- Switched project to ESM:
  - `package.json` now uses `"type": "module"`
  - TypeScript config updated to `module/moduleResolution: nodenext`
  - Local imports updated to use `.js` extensions for NodeNext compatibility
- Added MCP-related scripts:
  - `start:mcp`, `dev:mcp`
- yt-dlp integration extended with:
  - `fetchVideoInfo`
  - `fetchAvailableSubtitles`
  - shared handling for yt-dlp env flags (`--cookies`, `--js-runtimes`, `--remote-components`)
- Jest config renamed to `jest.config.cjs`

### Security

- Added `cookies.txt` to `.gitignore` to avoid accidental commits of sensitive cookies

## [0.2.0] - 2026-01-29

### Added

- Docker Compose configuration for easier container orchestration and deployment
- Cookie support for accessing age-restricted or region-locked YouTube videos
- `COOKIES_FILE_PATH` environment variable for persistent cookie file management
- `@fastify/multipart` dependency for handling file uploads in cookie requests
- Comprehensive cookie handling with proper sanitization and temporary file management

### Changed

- Refactored API routes in `src/index.ts` for improved code organization
- Updated README with detailed cookie usage examples and new environment variables
- Simplified validation logic by removing redundant cookie validation code
- Enhanced subtitle download function to support optional cookie parameters

### Removed

- Health check endpoint from Dockerfile (moved to application-level routing)

## [0.1.0] - 2025-12-27

### Added

- API for downloading subtitles from YouTube videos
- Support for official and auto-generated subtitles
- Support for multiple subtitle languages
- `/api/subtitles` endpoint for retrieving cleaned subtitles (plain text)
- `/api/subtitles/raw` endpoint for retrieving raw subtitles with timestamps
- Support for SRT and VTT formats
- `/health` endpoint for server health checks
- Input data validation using TypeBox schema validation
- Error handling with clear error messages
- Docker image for application deployment
- CORS support for cross-origin requests
- Request and error logging
- TypeScript for type safety
- Rate limiting with configurable limits and time windows
- Graceful shutdown handling (SIGTERM, SIGINT)
- Unhandled promise rejection and uncaught exception handlers
- Configurable yt-dlp command timeout via environment variables
- Configurable shutdown timeout via environment variables
- Jest testing framework with test coverage
- Unit tests for YouTube subtitle functionality
- Unit tests for request validation
