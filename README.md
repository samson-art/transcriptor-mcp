

# Transcriptor MCP

[![Dockerhub](https://img.shields.io/badge/Docker-artsamsonov/transcriptor--mcp-blue.svg)](https://hub.docker.com/r/artsamsonov/transcriptor-mcp)
[![GitHub License](https://img.shields.io/github/license/samson-art/transcriptor-mcp)](https://github.com/samson-art/transcriptor-mcp/blob/main/LICENSE)

An MCP server (stdio and remote Streamable HTTP) that fetches video transcripts/subtitles via `yt-dlp`, with pagination for large responses. Supports YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit. **Whisper fallback** — transcribes audio when subtitles are unavailable (local or OpenAI API). Works with Cursor and other MCP hosts.

## Overview

This repository ships the MCP server in two transports, both served by the same Node process:

- **stdio** (`node dist/mcp.js`): for local usage (e.g., Cursor running a local command).
- **Streamable HTTP** (`node dist/mcp-http-entry.js`): `POST /mcp` on port 4200 for remote usage (e.g. VPS + Tailscale); see [MCP quick start](#mcp-quick-start) and `docker-compose.example.yml`.

It also includes an optional **REST API** (Fastify), but MCP is the primary focus.

## Supported platforms

Unlike YouTube-only tools, Transcriptor MCP works across **11 major video platforms**:

YouTube · Twitter/X · Instagram · TikTok · Twitch · Vimeo · Facebook · Bilibili · VK · Dailymotion · Reddit

All URL-based tools (`get_transcript`, `get_raw_subtitles`, `get_available_subtitles`, `get_video_info`, `get_video_chapters`, `get_video_frame`, `get_playlist_transcripts`) accept video URLs from any supported platform. The `search_videos` tool is YouTube-specific (yt-dlp ytsearch).

## When to use Transcriptor MCP

Transcriptor MCP is the best choice when you need **transcripts and metadata** for AI, summarization, or content analysis — without downloading video or audio files:

- **Transcripts and subtitles** — cleaned text or raw SRT/VTT; multi-language; **Whisper fallback** when subtitles are unavailable (local or OpenAI).
- **Multi-platform** — YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit.
- **Remote and production** — native Streamable HTTP, auth terminated at your reverse proxy or gateway, Redis cache, Prometheus metrics.
- **No media downloads** — we focus on text and metadata only. For downloading videos or audio.

Use the sections in this README for setup, tools, and deployment patterns.

## How to connect

Choose one of these two main paths:

### 1) Local MCP (Docker)

Best when you want a fast local setup without Node on host.

The image serves Streamable HTTP by default, so ask for stdio explicitly:

```bash
docker run --rm -i artsamsonov/transcriptor-mcp:latest npm run start:mcp
```

Cursor MCP config:

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "artsamsonov/transcriptor-mcp:latest",
        "npm",
        "run",
        "start:mcp"
      ]
    }
  }
}
```

Detailed local + self-hosted HTTP instructions are in [How to connect](#how-to-connect) and [MCP quick start](#mcp-quick-start).

### 2) Remote MCP via Streamable HTTP

The MCP image serves Streamable HTTP itself on port 4200 — no sidecar. See [docker-compose.example.yml](docker-compose.example.yml) for a full stack (optional REST API + MCP).

After you deploy it (and optionally TLS or Bearer auth at a reverse proxy), point MCP clients at your endpoint, for example:

```text
https://your-host.example/mcp
```

Transport details: `POST /mcp` only — `GET`/`DELETE` return 405, and the server is stateless, so it issues no `Mcp-Session-Id`. The Node process does not validate Bearer tokens; configure auth on the reverse proxy or gateway in front of it. `GET /health` and `GET /metrics` are served on the same port for probes and Prometheus.

## Features

- **Multi-platform** — YouTube, Reddit, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion.
- **Transcripts + raw subtitles**: cleaned text or raw SRT/VTT.
- **Language support**: official subtitles with auto-generated fallback.
- **Video metadata**: extended info (title, channel, tags, thumbnails, etc.) and chapter markers.
- **Pagination**: safe for large transcripts.
- **Whisper fallback**: when subtitles are unavailable, transcribes video audio via Whisper (local self-hosted or OpenAI API); configurable via environment variables.
- **Optional Redis cache**: cache subtitles and metadata to reduce yt-dlp calls; configurable via environment variables.
- **Docker-first**: ready for local + remote deployment.
- **Production-friendly HTTP**: optional auth + allowlists for the REST API; remote MCP speaks **Streamable HTTP** directly and is usually fronted by your own reverse proxy for Bearer/TLS.
- **Prometheus**: `GET /metrics` on both the REST API and the MCP HTTP server (on `MCP_PORT`, default 4200), the latter exposing the MCP tool counters (`mcp_*`).

## Self-configurable: Whisper & caching

You can enable these features independently; both are **off by default**.

- **Whisper fallback** — When native subtitles are unavailable, transcribe video audio via Whisper (local self-hosted or OpenAI API). Configure via `WHISPER_MODE`, `WHISPER_BASE_URL`, `WHISPER_API_KEY`, etc.
- **Redis caching** — Cache subtitles and metadata to reduce yt-dlp calls. Configure via `CACHE_MODE=redis` and `CACHE_REDIS_URL`.

## MCP quick start

For full setup options (local Docker and self-hosted Streamable HTTP), use:

- [How to connect](#how-to-connect)
- [MCP Server (stdio and HTTP)](#mcp-server-stdio-and-http)

## MCP tools


| Tool                       | Purpose                          |
| -------------------------- | -------------------------------- |
| `get_transcript`           | Cleaned plain text (first chunk) |
| `get_raw_subtitles`        | Raw SRT/VTT, paginated           |
| `get_available_subtitles`  | List official/auto languages     |
| `get_video_info`           | Extended metadata                |
| `get_video_chapters`       | Chapter markers                  |
| `get_video_frame`          | Single frame image at timestamp  |
| `get_playlist_transcripts` | Batch transcripts from playlist  |
| `search_videos`            | YouTube search                   |


### MCP tool reference

All URL-based tools share the same base input:

- `url` (string, required) – Video URL from a supported platform or YouTube video ID. Supported: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit.

`get_raw_subtitles` supports pagination; `get_transcript` returns the first chunk only (no pagination input). Pagination parameters for `get_raw_subtitles`:

- `response_limit` (number, optional) – max characters per response, default `50000`, min `1000`, max `200000`.
- `next_cursor` (string, optional) – opaque offset returned from the previous page; pass it to fetch the next chunk.

Each tool returns:

- `content` – human-readable text (for MCP chat UIs).
- `structuredContent` – strongly typed JSON payload you can consume from automations or code.

#### `get_transcript`

**Purpose**: Fetch cleaned subtitles as plain text (no timestamps, HTML, or speaker metadata).

**Input**: Only `url` (video URL or ID). Type and language are auto-discovered; the tool returns the first chunk with default size (no pagination parameters).

**Structured response**:

- `videoId` – resolved YouTube ID.
- `type`, `lang` – effective subtitle type and language.
- `text` – current text chunk.
- `is_truncated` – `true` if more text is available.
- `total_length` – total length of the full transcript.
- `start_offset`, `end_offset` – character offsets of this chunk.
- `next_cursor` – present in response when truncated (omitted on the last page). Not accepted as input for this tool.

#### `get_raw_subtitles`

**Purpose**: Fetch raw subtitle file content (SRT or VTT) with pagination support.

**Extra input fields**:

- `type` – `"official"` or `"auto"`, optional.
- `lang` – subtitle language code, optional.
- `response_limit`, `next_cursor` – pagination (optional).

**Structured response**:

- `videoId`, `type`, `lang` – same semantics as above.
- `format` – `"srt"` or `"vtt"` (auto-detected from content).
- `content` – raw subtitle text for this page.
- `is_truncated`, `total_length`, `start_offset`, `end_offset`, `next_cursor` – same pagination fields as `get_transcript`.

#### `get_available_subtitles`

**Purpose**: Inspect which languages are available for a video, split into official vs auto-generated tracks.

**Input**:

- `url` – YouTube URL or video ID.

**Structured response**:

- `videoId` – resolved YouTube ID.
- `official` – sorted list of language codes with official subtitles.
- `auto` – sorted list of language codes with auto-generated subtitles.

This is useful to first discover languages and then pick `type`/`lang` for `get_raw_subtitles` (or other tools).

#### `get_video_info`

**Purpose**: Fetch extended metadata about a video (based on yt-dlp JSON output).

**Input**:

- `url` – YouTube URL or video ID.

**Structured response (key fields)**:

- `videoId` – resolved YouTube ID.
- `title`, `description`.
- `uploader`, `uploaderId`.
- `channel`, `channelId`, `channelUrl`.
- `duration` – in seconds.
- `uploadDate` – `YYYYMMDD` string if available.
- `webpageUrl`.
- `viewCount`, `likeCount`, `commentCount`.
- `tags`, `categories`.
- `liveStatus`, `isLive`, `wasLive`, `availability`.
- `thumbnail` – primary thumbnail URL.
- `thumbnails` – list of thumbnail variants `{ url, width?, height?, id? }`.

See `src/mcp-core.ts` and `src/youtube.ts` for the full JSON schema used by the MCP SDK.

#### `get_video_chapters`

**Purpose**: Get chapter markers extracted by yt-dlp.

**Input**:

- `url` – YouTube URL or video ID.

**Structured response**:

- `videoId` – resolved YouTube ID.
- `chapters` – array of `{ startTime: number; endTime: number; title: string }`.

If the video has no chapters, `chapters` is an empty array; if yt-dlp cannot fetch chapter data at all, the tool returns an MCP error instead of structured chapters.

#### `get_video_frame`

**Purpose**: Capture a single frame from a video at the given timestamp. Fast path resolves a direct stream URL via yt-dlp and seeks over HTTP with ffmpeg; if that fails, yt-dlp downloads a ~2s section and the frame is extracted locally. Requires `ffmpeg` (already included in the Docker image).

**Input**:

- `url` – Video URL or YouTube video ID.
- `timecode` (string, optional) – Timestamp as `"MM:SS"` or `"HH:MM:SS(.mmm)"`, e.g. `"01:23"` or `"00:01:23.500"`.
- `seconds` (number, optional) – Timestamp in seconds (alternative to `timecode`; provide at most one). Default: `0` (first frame).
- `format` (string, optional) – `"jpeg"` (default) or `"png"`.
- `width` (number, optional) – Output width in pixels, default `1280`, max `1920`. The frame is never upscaled.
- `quality` (number, optional) – JPEG quality (ffmpeg `-q:v`): `2` (best) to `31` (worst), default `4`. Ignored for png.

**Response `content`**: a text line (`Frame captured at 00:01:23.500`) plus an `image` content block with base64 data.

**Structured response**:

- `videoId` – resolved video ID.
- `timestampSeconds` – requested timestamp in seconds.
- `timestamp` – timestamp formatted as `HH:MM:SS.mmm`.
- `mimeType` – `image/jpeg` or `image/png`.
- `sizeBytes` – image size in bytes.
- `width` – actual output image width (may be smaller than requested for low-resolution sources; `null` if it cannot be determined).

Timeout is controlled by `YT_DLP_FRAME_TIMEOUT` (falls back to `YT_DLP_TIMEOUT`, default 60000 ms).

#### `get_playlist_transcripts`

**Purpose**: Fetch cleaned transcripts for multiple videos from a playlist in one call.

**Input**:

- `url` (string, required) – Playlist URL or watch URL with `list=` (e.g. `https://www.youtube.com/playlist?list=XXX`).
- `type` – `"official"` or `"auto"`, optional.
- `lang` – Subtitle language code, optional.
- `format` – Subtitle format (`srt`, `vtt`, `ass`, `lrc`), optional.
- `playlistItems` – yt-dlp `-I` spec (e.g. `1:5`, `1,3,7`, `-1`), optional.
- `maxItems` – Max videos to process, optional.

**Structured response**:

- `results` – array of `{ videoId, text }` for each video in the playlist.

#### `search_videos`

**Purpose**: Search videos on YouTube via yt-dlp (ytsearch). Returns a list of videos with metadata.

**Input**:

- `query` (string, required) – Search query.
- `limit` (number, optional) – Max results (default 10, max 50).
- `offset` (number, optional) – Skip first N results (pagination).
- `uploadDateFilter` (string, optional) – Filter by upload date: `hour`, `today`, `week`, `month`, or `year`.
- `response_format` (string, optional) – Human-readable format: `json` (default) or `markdown`.

**Structured response**:

- `results` – array of `{ videoId, title, url, duration, uploader, viewCount, thumbnail }`.

## Requirements

- **Docker** (recommended for production)
- **Node.js** >= 20.0.0 (for local development)
- **yt-dlp** (included in Docker image)

## REST API (optional)

The repository also ships an HTTP API (Fastify).

#### Quick Docker usage

- Build the image:
  ```bash
  docker build -t transcriptor-mcp-api -f Dockerfile --target api .
  ```
- Run on the default port:
  ```bash
  docker run -p 3000:3000 transcriptor-mcp-api
  ```

For a more complete REST quick start (including docker-compose and local Node.js),
use [REST API (optional)](#rest-api-optional) and [API Documentation](#api-documentation).

#### Swagger / OpenAPI

Once the REST API is running, interactive API docs are available at:

```text
http://localhost:3000/docs
```

If you change `PORT` / `HOST`, adjust the URL accordingly, e.g. `http://<HOST>:<PORT>/docs`.

#### Troubleshooting: restricted / sign-in required videos

If yt-dlp is blocked by age gate, sign-in, or region restrictions, you will likely need
an authenticated `cookies.txt` file and the `COOKIES_FILE_PATH` environment variable.

The root of this repository includes a sample `[cookies.example.txt](cookies.example.txt)`
showing the expected Netscape cookies format. For a full guide on:

- exporting real cookies
- wiring them into Docker / docker-compose / local Node.js
- and keeping them secure

keep credentials local and use `COOKIES_FILE_PATH` with a non-committed cookie file.

#### Run in background

```bash
docker run -d -p 3000:3000 --name transcriptor transcriptor-mcp-api
```

### E2E smoke tests (REST API + MCP, Docker)

Before publishing Docker images, you can run a small **e2e smoke test** that:

- Starts a REST API container and checks Swagger + `POST /subtitles` with a stable YouTube video
- Optionally starts an MCP container and checks **streamable HTTP** (`POST /mcp`: initialize without a session id, `tools/list`, a real `get_transcript` call, and `GET /mcp` → 405) plus **MCP stdio** (initialize over stdin/stdout), same stack as [docker-compose.example.yml](docker-compose.example.yml)

Run the smoke test (requires built images):

```bash
npm run build
docker build -t artsamsonov/transcriptor-mcp-api:latest -f Dockerfile --target api .
docker build -t artsamsonov/transcriptor-mcp:latest -f Dockerfile --target mcp .
npm run test:e2e:api
```

**Environment variables:**


| Variable                           | Default                                       | Description                                                                             |
| ---------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SMOKE_IMAGE_API`                  | —                                             | Full API image reference (overrides name/tag).                                          |
| `DOCKER_API_IMAGE` / `TAG`         | `artsamsonov/transcriptor-mcp-api`, `latest`  | API image name and tag.                                                                 |
| `SMOKE_API_URL` / `SMOKE_API_PORT` | `http://127.0.0.1:33000`, `33000`             | API base URL and port.                                                                  |
| `SMOKE_VIDEO_URL`                  | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | Video used for `/subtitles` check.                                                      |
| `SMOKE_SKIP_MCP`                   | —                                             | Set to `1` (or `true`/`yes`) to skip MCP checks.                                        |
| `SMOKE_MCP_IMAGE`                  | —                                             | Full MCP image reference (overrides name/tag).                                          |
| `DOCKER_MCP_IMAGE` / `TAG`         | `artsamsonov/transcriptor-mcp`, `latest`      | MCP image name and tag.                                                                 |
| `SMOKE_MCP_URL` / `SMOKE_MCP_PORT` | `http://127.0.0.1:4200`, `4200`               | MCP base URL and port.                                                                  |
| `SMOKE_MCP_AUTH_TOKEN`             | —                                             | If set, sent as `Authorization: Bearer` on MCP HTTP requests (for smoke against an edge that requires Bearer; the default smoke stack does not enforce it). |


Example: skip MCP and use a custom video:

```bash
SMOKE_SKIP_MCP=1 SMOKE_VIDEO_URL="https://www.youtube.com/watch?v=YOUR_ID" npm run test:e2e:api
```

#### View logs

```bash
docker logs -f transcriptor
```

#### Stop the container

```bash
docker stop transcriptor
docker rm transcriptor
```

## API Documentation

For detailed REST API endpoint documentation (request/response schemas, examples, etc.),
use the built-in Swagger UI at:

```text
http://localhost:3000/docs
```

or use [REST API (optional)](#rest-api-optional).

## MCP Server (stdio and HTTP)

The MCP server ships two transports and can be used via:

- remote Streamable HTTP — the image default (`docker run --rm -p 4200:4200 artsamsonov/transcriptor-mcp:latest`), or `npm run start:mcp:http`
- local Docker over stdio (`docker run --rm -i artsamsonov/transcriptor-mcp:latest npm run start:mcp`)
- local Node over stdio (`node dist/mcp.js`)

Use [How to connect](#how-to-connect) as the main guide for MCP setup variants; optional Bearer auth is configured on a reverse proxy or gateway in front of the HTTP transport.

## How It Works

1. The API receives a video URL (YouTube or other supported platform) and parameters (subtitle type and language) from the client
2. Extracts the video ID from the URL
3. Uses `yt-dlp` to download subtitles with the specified parameters:
  - Single `yt-dlp` command call with explicit type (`--write-subs` or `--write-auto-subs`) and language (`--sub-lang`)
4. Parses the subtitle file (SRT/VTT) and removes:
  - Timestamps
  - Subtitle numbers
  - HTML tags
  - Formatting
5. Returns clean plain text (for `/subtitles`) or raw content (for `/subtitles/raw`)

## Development

### Prerequisites

- Node.js >= 20.0.0
- npm or yarn
- yt-dlp installed and available in PATH

### Versioning

The app version is read from `package.json` at runtime (`[src/version.ts](src/version.ts)`). When cutting a release, update the `version` field in `package.json`, then create a git tag (e.g. `v0.4.7`). Changelog entries under `[Unreleased]` should be moved to the new version before tagging.

### Scripts

- `npm run build` - Build the TypeScript project
- `npm start` - Run the compiled application
- `npm run dev` - Run with hot reload using ts-node-dev
- `npm run start:mcp` - Run the MCP server (stdio)
- `npm run start:mcp:http` - Run the MCP server (Streamable HTTP on `MCP_PORT`, default 4200)
- `npm run dev:mcp` - Run the MCP server with hot reload (stdio)
- `npm run dev:mcp:http` - Run the MCP HTTP server with hot reload
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run lint` - Lint the code
- `npm run lint:fix` - Fix linting errors
- `npm run type-check` - Type check without building
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting

### Project Structure

```
├── src/
│   ├── index.ts                    # HTTP API (Fastify)
│   ├── mcp.ts                      # MCP server entry (stdio)
│   ├── mcp-http.ts                 # MCP server over Streamable HTTP (Fastify)
│   ├── mcp-http-entry.ts           # MCP HTTP entry point
│   ├── mcp-core.ts                 # MCP tools registration
│   ├── validation.ts               # Request validation
│   ├── youtube.ts                  # Subtitle download and parsing (yt-dlp)
│   ├── yt-dlp-check.ts             # yt-dlp availability checks
│   ├── whisper.ts                  # Whisper API client
│   ├── whisper-jobs.ts             # Async Whisper jobs
│   ├── cache.ts                    # Response / subtitle caching
│   ├── metrics.ts                  # Prometheus metrics (/metrics)
│   ├── lifecycle.ts                # Graceful shutdown hooks
│   ├── instrument.ts               # Sentry initialization
│   ├── logger-sentry-breadcrumbs.ts
│   ├── errors.ts                   # Error types and HTTP mapping
│   ├── env.ts                      # Environment configuration
│   ├── version.ts                  # App version (from package.json)
│   ├── changelog.ts                # Changelog data for API
│   ├── e2e/                        # API / MCP smoke tests (Docker)
│   │   ├── api-smoke.ts
│   │   ├── mcp-smoke.ts
│   │   ├── docker-utils.ts
│   │   └── smoke-env.ts
│   └── *.test.ts                   # Unit tests (Jest), co-located
├── dist/                           # Compiled JavaScript (npm run build)
├── load/                           # Load-test scripts (k6)
├── .github/workflows/              # CI and Docker Hub publish
├── Dockerfile                      # API and MCP images (--target api|mcp)
├── docker-compose.example.yml      # Example API + MCP stack
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── jest.config.cjs
└── README.md
```

## Technologies

- **TypeScript** - Type-safe JavaScript
- **Node.js** - Runtime environment
- **Fastify** - Fast and low overhead web framework
- **yt-dlp** - YouTube content downloader
- **Docker** - Containerization
- **Jest** - Testing framework
- **ESLint** - Code linting
- **Prettier** - Code formatting

## Security

**Data and keys:** Video URLs are sent to yt-dlp for subtitle extraction. Keys and tokens are stored only in your environment; we never log or share them.

Do not commit or log sensitive values. Use environment variables or a secret manager (e.g. vault, cloud secrets) for:

- `**WHISPER_API_KEY`** – required when using Whisper API; never log or expose in client responses.
- `**CACHE_REDIS_URL**` – Redis connection string when `CACHE_MODE=redis`; may contain credentials.
- **MCP Bearer secrets** – if you terminate auth at a reverse proxy or gateway in front of the MCP HTTP server, store tokens only in env/secrets on that edge.
- `**COOKIES_FILE_PATH**` – path to cookies; ensure the file is not committed and has restricted permissions.

Use `cookies.example.txt` as a format template and keep real cookies outside git.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please make sure your code passes all tests and linting checks before submitting.

## License

MIT License

Copyright (c) 2025 samson-art

See [LICENSE](LICENSE) file for details.

## Support

- **Bug reports**: [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
- **Feature requests**: [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
- **Contact**: [GitHub Profile](https://github.com/samson-art)

