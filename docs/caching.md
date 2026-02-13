# Caching (Redis)

When Redis cache is enabled, the app stores successful responses so that repeated requests for the same video (and language/type for subtitles) are served from cache instead of calling yt-dlp again. This reduces latency and load on YouTube and other platforms.

## What is cached

| Data | Cache key pattern | TTL (env) |
|------|-------------------|-----------|
| Subtitles (text, YouTube or Whisper) | `sub:{url}:{type}:{lang}` | `CACHE_TTL_SUBTITLES_SECONDS` (default 7 days) |
| Available subtitle languages | `avail:{url}` | `CACHE_TTL_METADATA_SECONDS` (default 1 hour) |
| Video info (title, channel, views, etc.) | `info:{url}` | `CACHE_TTL_METADATA_SECONDS` |
| Video chapters | `chapters:{url}` | `CACHE_TTL_METADATA_SECONDS` |

Only successful responses are cached. Errors (e.g. subtitles not found) are not cached.

## Enabling Redis cache

1. Set `CACHE_MODE=redis`.
2. Set `CACHE_REDIS_URL` to your Redis connection URL.

Example `.env`:

```env
CACHE_MODE=redis
CACHE_REDIS_URL=redis://localhost:6379
CACHE_TTL_SUBTITLES_SECONDS=604800
CACHE_TTL_METADATA_SECONDS=3600
```

With Docker Compose, add Redis as a service and set the same variables for the transcriptor container. Example:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  transcriptor-mcp:
    image: artsamsonov/transcriptor-mcp:latest
    environment:
      CACHE_MODE: redis
      CACHE_REDIS_URL: redis://redis:6379
    depends_on:
      - redis
```

## Disabling cache

Leave `CACHE_MODE` unset or set it to `off`. No Redis connection is made when cache is off.

## When Redis is unavailable

If Redis is configured (`CACHE_MODE=redis`) but the connection fails or Redis returns errors on `get`/`set`, the app does **not** fail the request. It logs a warning and continues without cache: the request is served by calling yt-dlp (or Whisper) as if cache were off. This graceful degradation ensures that a Redis outage or network issue does not break subtitle or metadata delivery.
