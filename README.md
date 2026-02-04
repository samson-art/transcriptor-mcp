<div align="center">
  <img src="./logo.webp" alt="yt-captions logo" width="160" />

  <h1>YouTube Captions MCP Server</h1>

  <p>
    <img alt="version" src="https://img.shields.io/badge/version-0.3.4-blue" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-green" />
    <img alt="docker" src="https://img.shields.io/badge/docker-available-0db7ed" />
  </p>

  <p>
    An MCP server (stdio + HTTP/SSE) that fetches YouTube transcripts/subtitles via <code>yt-dlp</code>,
    with pagination for large responses. Works with Cursor and other MCP hosts.
  </p>

  <p>
    <a href="https://github.com/samson-art/yt-captions-mcp">GitHub</a>
    ·
    <a href="https://github.com/samson-art/yt-captions-mcp/issues">Issues</a>
    ·
    <a href="https://hub.docker.com/r/artsamsonov/yt-captions-mcp">Docker Hub</a>
  </p>
</div>

## Overview

This repository primarily ships an **MCP server**:

- **stdio**: for local usage (e.g., Cursor running a local command).
- **HTTP/SSE**: for remote usage (e.g., VPS + Tailscale).

It also includes an optional **REST API** (Fastify), but MCP is the primary focus.

## Features

- **Transcripts + raw subtitles**: cleaned text or raw SRT/VTT.
- **Language support**: official subtitles with auto-generated fallback.
- **Video metadata**: extended info (title, channel, tags, thumbnails, etc.) and chapter markers.
- **Pagination**: safe for large transcripts.
- **Docker-first**: ready for local + remote deployment.
- **Production-friendly HTTP**: optional auth + allowlists (see `CHANGELOG.md`).

## Example usage (screenshot)

Below is a real-world example of the same “summarize YouTube video” task without MCP vs with MCP:

<picture>
  <source srcset="./example-usage.webp" type="image/webp" />
  <img src="./example-usage.webp" alt="Example usage: without MCP vs with MCP" />
</picture>

## MCP quick start (recommended)

### Docker Hub (stdio)

- Image: `artsamsonov/yt-captions-mcp:latest`

Run locally (stdio mode):

```bash
docker run --rm -i artsamsonov/yt-captions-mcp:latest
```

### Cursor MCP configuration (Docker)

Add to Cursor MCP settings (or create `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "yt-captions": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/yt-captions-mcp:latest"]
    }
  }
}
```

### Remote MCP over HTTP/SSE (VPS + Tailscale)

Run the HTTP/SSE MCP server on your VPS (default port `4200`) using docker-compose:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d yt-captions-mcp
```

**Claude Code (HTTP / streamable HTTP):**

```bash
claude mcp add --transport http yt-captions http://<tailscale-host>:4200/mcp
```

**Cursor (SSE):**

- Add a new MCP server of type **SSE** with URL `http://<tailscale-host>:4200/sse`

If you set `MCP_AUTH_TOKEN`, add `Authorization: Bearer <token>` in the client headers.

**n8n MCP Client (streamable HTTP):**

- Use the MCP Server URL `http://<host>:4200/mcp` (streamable HTTP transport).
- If n8n runs behind a reverse proxy that sets `X-Forwarded-For`, set `N8N_PROXY_HOPS`
  to the number of proxy hops (commonly `1`) to avoid `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.

## MCP tools

- `get_transcript`: cleaned plain text subtitles (paginated)
- `get_raw_subtitles`: raw SRT/VTT (paginated)
- `get_available_subtitles`: list official vs auto language codes
- `get_video_info`: extended metadata (title, channel, tags, thumbnails, views, etc.)
- `get_video_chapters`: chapter markers with start/end time and title

### MCP tool reference

All tools share the same base input:

- `url` (string, required) – YouTube URL or plain video ID.

Tools that return large text (`get_transcript`, `get_raw_subtitles`) also support pagination:

- `response_limit` (number, optional) – max characters per response, default `50000`, min `1000`, max `200000`.
- `next_cursor` (string, optional) – opaque offset returned from the previous page; pass it to fetch the next chunk.

Each tool returns:

- `content` – human-readable text (for MCP chat UIs).
- `structuredContent` – strongly typed JSON payload you can consume from automations or code.

#### `get_transcript`

**Purpose**: Fetch cleaned subtitles as plain text (no timestamps, HTML, or speaker metadata).

**Extra input fields**:

- `type` – `"official"` or `"auto"`, default `"auto"`.
- `lang` – subtitle language code (e.g. `"en"`, `"ru"`, `"en-US"`), default `"en"`.

**Structured response**:

- `videoId` – resolved YouTube ID.
- `type`, `lang` – effective subtitle type and language.
- `text` – current text chunk.
- `is_truncated` – `true` if more text is available.
- `total_length` – total length of the full transcript.
- `start_offset`, `end_offset` – character offsets of this chunk.
- `next_cursor` – pass into the next call to continue pagination (omitted on the last page).

#### `get_raw_subtitles`

**Purpose**: Fetch raw subtitle file content (SRT or VTT) with pagination support.

**Extra input fields**:

- Same as `get_transcript` (`type`, `lang`, `response_limit`, `next_cursor`).

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

This is useful to first discover languages and then pick `type`/`lang` for `get_transcript` / `get_raw_subtitles`.

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

## Requirements

- **Docker** (recommended for production)
- **Node.js** >= 20.0.0 (for local development)
- **yt-dlp** (included in Docker image)

## REST API (optional)

The repository also ships an HTTP API (Fastify). If you want to run the REST API in Docker, build it locally from `Dockerfile`:

#### Build the image

```bash
docker build -t yt-captions-downloader .
```

#### Run the container

```bash
docker run -p 3000:3000 yt-captions-downloader
```

#### Run with custom port

```bash
docker run -p 8080:8080 -e PORT=8080 yt-captions-downloader
```

#### Environment Variables

- `PORT` - Server port (default: `3000`)
- `HOST` - Server host (default: `0.0.0.0`)
- `YT_DLP_TIMEOUT` - Timeout for yt-dlp command in milliseconds (default: `60000` - 60 seconds)
- `YT_DLP_JS_RUNTIMES` - JS runtime(s) for yt-dlp extraction (e.g., `node` or `node:/usr/bin/node`)
- `COOKIES_FILE_PATH` - Path to `cookies.txt` in Netscape format (optional, for age-restricted/sign-in)
- `RATE_LIMIT_MAX` - Maximum number of requests per time window (default: `100`)
- `RATE_LIMIT_TIME_WINDOW` - Time window for rate limiting (default: `1 minute`)
- `SHUTDOWN_TIMEOUT` - Graceful shutdown timeout in milliseconds (default: `10000` - 10 seconds)

**Example with custom yt-dlp timeout:**

```bash
docker run -p 3000:3000 -e YT_DLP_TIMEOUT=120000 yt-captions-downloader
```

### Troubleshooting: age-restricted / sign-in required

If yt-dlp is blocked by an age gate or sign-in requirement, requests can return `404 Subtitles not found`.
Provide authenticated cookies via `COOKIES_FILE_PATH` and mount the file into the container:

```bash
docker run -p 3000:3000 \
  -e COOKIES_FILE_PATH=/cookies/cookies.txt \
  -v /path/to/cookies.txt:/cookies/cookies.txt:ro \
  yt-captions-downloader
```

#### Run in background

```bash
docker run -d -p 3000:3000 --name yt-captions yt-captions-downloader
```

### E2E smoke tests for REST API (Docker)

Before publishing Docker images, you can run a small **e2e smoke test** that:

- Builds a local REST API image
- Starts a container from that image
- Performs a real `POST /subtitles` request for a stable YouTube video
- Fails fast if something is broken (build, startup, or basic functionality)

#### Run smoke tests locally

Build the local image and run the smoke test:

```bash
make docker-build-api
make docker-smoke-api-local
```

Or run the aggregated target (includes all Docker-based smoke tests that are defined):

```bash
make smoke
```

By default, the smoke test uses:

- Image: `artsamsonov/yt-captions-downloader:latest` (or overridden via `TAG` / `DOCKER_API_IMAGE`)
- Video: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`

You can override the video (and other settings) via environment variables:

```bash
SMOKE_VIDEO_URL="https://www.youtube.com/watch?v=<YOUR_VIDEO_ID>" make docker-smoke-api-local
```

#### Smoke tests in `make publish`

The `publish-docker-api` target now ensures the following sequence:

1. `check` (format, lint, typecheck, unit tests, build)
2. Local Docker build for the REST API image
3. Docker-based e2e smoke test (`docker-smoke-api-local`)
4. Multi-arch build & push via `docker-buildx-api`

#### View logs

```bash
docker logs -f yt-captions
```

#### Stop the container

```bash
docker stop yt-captions
docker rm yt-captions
```

## API Documentation

### POST /subtitles

Retrieve cleaned subtitles (plain text without timestamps) from a YouTube video.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "type": "auto",
  "lang": "en"
}
```

**Parameters:**
- `url` (required) - YouTube video URL
- `type` (optional, default: `"auto"`) - Subtitle type: `"official"` (official subtitles) or `"auto"` (auto-generated subtitles)
- `lang` (optional, default: `"en"`) - Subtitle language code (e.g., `"en"`, `"ru"`, `"es"`, `"fr"`)

**Response (Success):**
```json
{
  "videoId": "VIDEO_ID",
  "type": "auto",
  "lang": "en",
  "text": "Plain text subtitles without timestamps...",
  "length": 1234
}
```

**Response (Error):**
```json
{
  "error": "Error type",
  "message": "Error message"
}
```

**Example Requests:**

Auto-generated subtitles in English (default):
```bash
curl -X POST http://localhost:3000/subtitles \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

Official subtitles in Russian:
```bash
curl -X POST http://localhost:3000/subtitles \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type": "official", "lang": "ru"}'
```

Auto-generated subtitles in Spanish:
```bash
curl -X POST http://localhost:3000/subtitles \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type": "auto", "lang": "es"}'
```

### POST /subtitles/raw

Retrieve raw subtitles from a YouTube video without cleaning (includes timestamps and formatting).

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "type": "auto",
  "lang": "en"
}
```

**Parameters:**
- `url` (required) - YouTube video URL
- `type` (optional, default: `"auto"`) - Subtitle type: `"official"` or `"auto"`
- `lang` (optional, default: `"en"`) - Subtitle language code

**Response (Success):**
```json
{
  "videoId": "VIDEO_ID",
  "type": "auto",
  "lang": "en",
  "format": "srt",
  "content": "1\n00:00:00,000 --> 00:00:05,000\nHello world\n\n2\n00:00:05,000 --> 00:00:10,000\n...",
  "length": 1234
}
```

**Response Fields:**
- `videoId` - YouTube video ID
- `type` - Subtitle type (`"official"` or `"auto"`)
- `lang` - Subtitle language code
- `format` - Subtitle format (`"srt"` or `"vtt"`)
- `content` - Raw subtitle file content (SRT or VTT format) without processing
- `length` - Content length in characters

**Response (Error):**
```json
{
  "error": "Error type",
  "message": "Error message"
}
```

**Example Requests:**

Get raw auto-generated subtitles in English:
```bash
curl -X POST http://localhost:3000/subtitles/raw \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

Get raw official subtitles in Russian:
```bash
curl -X POST http://localhost:3000/subtitles/raw \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type": "official", "lang": "ru"}'
```

### POST /subtitles/available

Retrieve the list of available subtitle languages for a YouTube video, split into official and auto-generated subtitles.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Parameters:**
- `url` (required) - YouTube video URL

**Response (Success):**
```json
{
  "videoId": "VIDEO_ID",
  "official": ["en", "ru"],
  "auto": ["en"]
}
```

**Response Fields:**
- `videoId` - YouTube video ID
- `official` - Sorted list of language codes with official subtitles
- `auto` - Sorted list of language codes with auto-generated subtitles

**Response (Error):**
```json
{
  "error": "Error type",
  "message": "Error message"
}
```

**Example Request:**

```bash
curl -X POST http://localhost:3000/subtitles/available \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### POST /video/info

Retrieve extended metadata for a YouTube video.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Parameters:**
- `url` (required) - YouTube video URL

**Response (Success):**
```json
{
  "videoId": "VIDEO_ID",
  "id": "VIDEO_ID",
  "title": "Video Title",
  "uploader": "Channel Name",
  "uploaderId": "channel_id",
  "channel": "Channel Name",
  "channelId": "channel_id",
  "channelUrl": "https://www.youtube.com/channel/...",
  "duration": 300,
  "description": "Video description...",
  "uploadDate": "20250101",
  "webpageUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "viewCount": 1000,
  "likeCount": 50,
  "commentCount": 25,
  "tags": ["tag1", "tag2"],
  "categories": ["Education"],
  "liveStatus": "not_live",
  "isLive": false,
  "wasLive": false,
  "availability": "public",
  "thumbnail": "https://i.ytimg.com/vi/VIDEO_ID/maxresdefault.jpg",
  "thumbnails": [
    { "url": "https://...", "width": 120, "height": 90, "id": "0" }
  ]
}
```

**Response Fields:**
- `videoId`, `id` - YouTube video ID
- `title`, `channel`, `duration`, `description`, `uploadDate` - Basic metadata
- `viewCount`, `likeCount`, `commentCount` - Engagement metrics
- `tags`, `categories` - Content classification
- `liveStatus`, `isLive`, `wasLive`, `availability` - Live/availability info
- `thumbnail`, `thumbnails` - Preview images (may be `null` if unavailable)

**Example Request:**

```bash
curl -X POST http://localhost:3000/video/info \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### POST /video/chapters

Retrieve chapter markers for a YouTube video.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Parameters:**
- `url` (required) - YouTube video URL

**Response (Success):**
```json
{
  "videoId": "VIDEO_ID",
  "chapters": [
    { "startTime": 0, "endTime": 60, "title": "Intro" },
    { "startTime": 60, "endTime": 300, "title": "Main content" },
    { "startTime": 300, "endTime": 320, "title": "Outro" }
  ]
}
```

**Response Fields:**
- `videoId` - YouTube video ID
- `chapters` - Array of chapter objects; empty array if the video has no chapters
- `startTime`, `endTime` - Chapter boundaries in seconds
- `title` - Chapter title

**Example Request:**

```bash
curl -X POST http://localhost:3000/video/chapters \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## MCP Server (stdio)

This project also ships an MCP server over stdio. It reuses the same `yt-dlp` based extraction and can return full transcript text or raw subtitles. Cursor configuration examples are provided below, but it should work with any MCP host that supports stdio.

### Pagination

Tools that return large text accept:
- `response_limit` (default `50000`, min `1000`, max `200000`)
- `next_cursor` (string offset from a previous response)

If the response is truncated, the tool returns `next_cursor` so you can fetch the next chunk.

### Local setup

```bash
npm install
npm run build
npm run start:mcp
```

### HTTP setup (remote)

```bash
npm run build
MCP_PORT=4200 MCP_HOST=0.0.0.0 npm run start:mcp:http
```

### Cursor MCP configuration (local)

Create `.cursor/mcp.json` (or add to your global Cursor MCP settings):

```json
{
  "mcpServers": {
    "yt-captions": {
      "command": "node",
      "args": ["dist/mcp.js"]
    }
  }
}
```

### Docker setup

Build and run the MCP server in a container (stdio mode):

```bash
docker build -f Dockerfile.mcp -t yt-captions-mcp .
docker run --rm -i yt-captions-mcp
```

Build and run the MCP server in a container (HTTP mode):

```bash
docker build -f Dockerfile.mcp -t yt-captions-mcp .
docker run -p 4200:4200 -e MCP_PORT=4200 -e MCP_HOST=0.0.0.0 yt-captions-mcp npm run start:mcp:http
```

Cursor MCP config for Docker:

```json
{
  "mcpServers": {
    "yt-captions": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/yt-captions-mcp:latest"]
    }
  }
}
```

## How It Works

1. The API receives a YouTube URL and parameters (subtitle type and language) from the client
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

### Scripts

- `npm run build` - Build the TypeScript project
- `npm start` - Run the compiled application
- `npm run dev` - Run with hot reload using ts-node-dev
- `npm run start:mcp` - Run the MCP server (stdio)
- `npm run start:mcp:http` - Run the MCP server (HTTP/SSE)
- `npm run dev:mcp` - Run the MCP server with hot reload
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
│   ├── index.ts          # Main application entry point
│   ├── mcp.ts            # MCP server entry point (stdio)
│   ├── mcp-core.ts       # MCP tools registration (shared)
│   ├── mcp-http.ts       # MCP server entry point (HTTP/SSE)
│   ├── validation.ts     # Request validation logic
│   └── youtube.ts        # YouTube subtitle downloading and parsing
├── dist/                 # Compiled JavaScript (generated)
├── Dockerfile            # Docker image configuration
├── logo.webp             # Project logo used in README
├── example-usage.webp    # Example usage screenshot used in README
├── package.json
├── tsconfig.json
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

- **Bug reports**: [GitHub Issues](https://github.com/samson-art/yt-captions-downloader/issues)
- **Feature requests**: [GitHub Issues](https://github.com/samson-art/yt-captions-downloader/issues)
- **Contact**: [GitHub Profile](https://github.com/samson-art)
