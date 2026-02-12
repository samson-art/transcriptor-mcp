## REST API quick start

The project includes an optional HTTP API built with Fastify.  
Use this if you want to call endpoints directly from scripts, backends, or API clients.

**Supported platforms:** All endpoints accept a `url` body field with a video URL from YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, or Dailymotion. A bare YouTube video ID is also accepted (e.g. `dQw4w9WgXcQ`).

For a full list of configuration options, see `docs/configuration.md`.

## Running the REST API

### Docker (build locally)

Build the image:

```bash
docker build -t transcriptor-mcp-api .
```

Run the container on the default port:

```bash
docker run -p 3000:3000 transcriptor-mcp-api
```

Run with a custom port:

```bash
docker run -p 8080:8080 -e PORT=8080 transcriptor-mcp-api
```

### Docker Compose

An example compose file is provided as `docker-compose.example.yml` in the repository root:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d transcriptor-mcp-api
```

By default this exposes the REST API on `http://localhost:3000`.

### Local Node.js

Install dependencies and build:

```bash
npm install
npm run build
```

Start the REST API:

```bash
npm start
```

The server listens on:

- `PORT` (default: `3000`)
- `HOST` (default: `0.0.0.0`)

These can be set via environment variables or an `.env` file (see `docs/configuration.md`).

## Swagger / OpenAPI UI

Once the REST API is running, interactive API docs are available via Swagger UI.

- **Default URL** (when running on localhost with default env):

  ```text
  http://localhost:3000/docs
  ```

- **Custom host/port**:

  ```text
  http://<HOST>:<PORT>/docs
  ```

The Swagger/OpenAPI setup is registered in `src/index.ts` with `routePrefix: '/docs'`.  
All REST endpoints are documented there, including request/response schemas.

## Core endpoints (overview)

Below is a high-level overview of the available endpoints. For detailed schemas and examples,
use Swagger UI or inspect the TypeBox schemas in `src/index.ts` and `src/validation.ts`.

- `POST /subtitles` – cleaned subtitles (plain text without timestamps)
- `POST /subtitles/raw` – raw subtitles (SRT/VTT) with timestamps and formatting
- `POST /subtitles/available` – lists available subtitle languages (official vs auto-generated)
- `POST /video/info` – extended video metadata (title, channel, stats, etc.)
- `POST /video/chapters` – chapter markers with start/end times and titles

## Minimal curl examples

### Cleaned subtitles

```bash
curl -X POST http://localhost:3000/subtitles \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### Available subtitle languages

```bash
curl -X POST http://localhost:3000/subtitles/available \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### Video info

```bash
curl -X POST http://localhost:3000/video/info \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

For more advanced usage (subtitle type/language, pagination, etc.), refer to Swagger UI.

