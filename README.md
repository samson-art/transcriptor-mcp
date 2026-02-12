<div align="center">
  <img src="./logo.webp" alt="transcriptor-mcp logo" width="160" />

  <h1>YouTube Captions MCP Server</h1>

  <p>
    <img alt="version" src="https://img.shields.io/badge/version-0.3.4-blue" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-green" />
    <img alt="docker" src="https://img.shields.io/badge/docker-available-0db7ed" />
  </p>

  <p>
    An MCP server (stdio + HTTP/SSE) that fetches video transcripts/subtitles via <code>yt-dlp</code>,
    with pagination for large responses. Supports YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion. Works with Cursor and other MCP hosts.
  </p>

  <p>
    <a href="https://github.com/samson-art/transcriptor-mcp">GitHub</a>
    ·
    <a href="https://github.com/samson-art/transcriptor-mcp/issues">Issues</a>
    ·
    <a href="https://hub.docker.com/r/artsamsonov/transcriptor-mcp">Docker Hub</a>
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

- Image: `artsamsonov/transcriptor-mcp:latest`

Run locally (stdio mode):

```bash
docker run --rm -i artsamsonov/transcriptor-mcp:latest
```

### Cursor MCP configuration (Docker)

Add to Cursor MCP settings (or create `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/transcriptor-mcp:latest"]
    }
  }
}
```

### Remote MCP over HTTP/SSE (VPS + Tailscale)

Run the HTTP/SSE MCP server on your VPS (default port `4200`) using docker-compose:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d transcriptor-mcp
```

**Claude Code (HTTP / streamable HTTP):**

```bash
claude mcp add --transport http transcriptor http://<tailscale-host>:4200/mcp
```

**Cursor (SSE):**

- Add a new MCP server of type **SSE** with URL `http://<tailscale-host>:4200/sse`

If you set `MCP_AUTH_TOKEN`, add `Authorization: Bearer <token>` in the client headers.

For more MCP configuration examples, see [`docs/quick-start.mcp.md`](docs/quick-start.mcp.md).

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

- `url` (string, required) – Video URL from a supported platform or YouTube video ID. Supported: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion.

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

The repository also ships an HTTP API (Fastify).

#### Quick Docker usage

- Build the image:

  ```bash
  docker build -t transcriptor-mcp-api .
  ```

- Run on the default port:

  ```bash
  docker run -p 3000:3000 transcriptor-mcp-api
  ```

For a more complete REST quick start (including docker-compose and local Node.js),
see [`docs/quick-start.rest.md`](docs/quick-start.rest.md).

#### Swagger / OpenAPI

Once the REST API is running, interactive API docs are available at:

```text
http://localhost:3000/docs
```

If you change `PORT` / `HOST`, adjust the URL accordingly, e.g. `http://<HOST>:<PORT>/docs`.

#### Troubleshooting: restricted / sign-in required videos

If yt-dlp is blocked by age gate, sign-in, or region restrictions, you will likely need
an authenticated `cookies.txt` file and the `COOKIES_FILE_PATH` environment variable.

The root of this repository includes a sample [`cookies.example.txt`](cookies.example.txt)
showing the expected Netscape cookies format. For a full guide on:

- exporting real cookies
- wiring them into Docker / docker-compose / local Node.js
- and keeping them secure

see [`docs/cookies.md`](docs/cookies.md).

#### Run in background

```bash
docker run -d -p 3000:3000 --name transcriptor transcriptor-mcp-api
```

### E2E smoke tests (REST API + MCP, Docker)

Before publishing Docker images, you can run a small **e2e smoke test** that:

- Starts a REST API container and checks Swagger + `POST /subtitles` with a stable YouTube video
- Optionally starts an MCP container and checks **MCP stdio** (initialize over stdin/stdout), **streamable HTTP** (`POST /mcp` with initialize), and **SSE** (`GET /sse`)

Run the smoke test (requires built images):

```bash
npm run build
docker build -t artsamsonov/transcriptor-mcp-api:latest -f Dockerfile .
docker build -t artsamsonov/transcriptor-mcp:latest -f Dockerfile.mcp .
npm run test:e2e:api
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SMOKE_IMAGE_API` | — | Full API image reference (overrides name/tag). |
| `DOCKER_API_IMAGE` / `TAG` | `artsamsonov/transcriptor-mcp-api`, `latest` | API image name and tag. |
| `SMOKE_API_URL` / `SMOKE_API_PORT` | `http://127.0.0.1:33000`, `33000` | API base URL and port. |
| `SMOKE_VIDEO_URL` | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | Video used for `/subtitles` check. |
| `SMOKE_SKIP_MCP` | — | Set to `1` (or `true`/`yes`) to skip MCP checks. |
| `SMOKE_MCP_IMAGE` | — | Full MCP image reference (overrides name/tag). |
| `DOCKER_MCP_IMAGE` / `TAG` | `artsamsonov/transcriptor-mcp`, `latest` | MCP image name and tag. |
| `SMOKE_MCP_URL` / `SMOKE_MCP_PORT` | `http://127.0.0.1:4200`, `4200` | MCP base URL and port. |
| `SMOKE_MCP_AUTH_TOKEN` | — | If set, passed to MCP container as `MCP_AUTH_TOKEN` and sent as Bearer in MCP requests. |

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

or see [`docs/quick-start.rest.md`](docs/quick-start.rest.md).


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
    "transcriptor": {
      "command": "node",
      "args": ["dist/mcp.js"]
    }
  }
}
```

### Docker setup

Build and run the MCP server in a container (stdio mode):

```bash
docker build -f Dockerfile.mcp -t transcriptor-mcp .
docker run --rm -i transcriptor-mcp
```

Build and run the MCP server in a container (HTTP mode):

```bash
docker build -f Dockerfile.mcp -t transcriptor-mcp .
docker run -p 4200:4200 -e MCP_PORT=4200 -e MCP_HOST=0.0.0.0 transcriptor-mcp npm run start:mcp:http
```

Cursor MCP config for Docker:

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/transcriptor-mcp:latest"]
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

- **Bug reports**: [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
- **Feature requests**: [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
- **Contact**: [GitHub Profile](https://github.com/samson-art)
