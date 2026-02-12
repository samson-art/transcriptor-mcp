# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
