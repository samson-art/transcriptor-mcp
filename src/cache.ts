import Redis from 'ioredis';

export type CacheMode = 'off' | 'redis';

const DEFAULT_TTL_SUBTITLES_SECONDS = 604800; // 7 days
const DEFAULT_TTL_METADATA_SECONDS = 3600; // 1 hour

export type CacheConfig = {
  mode: CacheMode;
  redisUrl: string | undefined;
  ttlSubtitlesSeconds: number;
  ttlMetadataSeconds: number;
};

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: string[]): Promise<string>;
  quit(): Promise<string>;
}

let redisClient: RedisLike | null = null;

/**
 * Reads cache configuration from environment.
 * Exported for testing.
 */
export function getCacheConfig(): CacheConfig {
  const raw = process.env.CACHE_MODE?.trim().toLowerCase();
  const mode: CacheMode = raw === 'redis' ? 'redis' : 'off';

  const ttlSubtitles = process.env.CACHE_TTL_SUBTITLES_SECONDS
    ? Number.parseInt(process.env.CACHE_TTL_SUBTITLES_SECONDS, 10)
    : DEFAULT_TTL_SUBTITLES_SECONDS;
  const ttlMetadata = process.env.CACHE_TTL_METADATA_SECONDS
    ? Number.parseInt(process.env.CACHE_TTL_METADATA_SECONDS, 10)
    : DEFAULT_TTL_METADATA_SECONDS;

  return {
    mode,
    redisUrl: process.env.CACHE_REDIS_URL?.trim(),
    ttlSubtitlesSeconds: Number.isFinite(ttlSubtitles)
      ? ttlSubtitles
      : DEFAULT_TTL_SUBTITLES_SECONDS,
    ttlMetadataSeconds: Number.isFinite(ttlMetadata) ? ttlMetadata : DEFAULT_TTL_METADATA_SECONDS,
  };
}

function getRedisClient(): RedisLike | null {
  if (redisClient) {
    return redisClient;
  }
  const config = getCacheConfig();
  if (config.mode !== 'redis' || !config.redisUrl) {
    if (config.mode === 'redis' && !config.redisUrl) {
      console.warn('CACHE_MODE=redis but CACHE_REDIS_URL is not set; cache disabled.');
    }
    return null;
  }
  const RedisConstructor = Redis as unknown as new (url: string) => RedisLike;
  redisClient = new RedisConstructor(config.redisUrl);
  return redisClient;
}

/**
 * Returns cached string value for the key, or undefined if missing or cache is off.
 */
export async function get(key: string): Promise<string | undefined> {
  const config = getCacheConfig();
  if (config.mode !== 'redis') {
    return undefined;
  }
  const client = getRedisClient();
  if (!client) {
    return undefined;
  }
  try {
    const value = await client.get(key);
    return typeof value === 'string' ? value : undefined;
  } catch (err) {
    console.warn({ err, key }, 'Cache get error');
    return undefined;
  }
}

/**
 * Stores value with the given TTL in seconds. No-op if cache is off.
 */
export async function set(key: string, value: string, ttlSeconds: number): Promise<void> {
  const config = getCacheConfig();
  if (config.mode !== 'redis') {
    return;
  }
  const client = getRedisClient();
  if (!client) {
    return;
  }
  try {
    await client.set(key, value, 'EX', String(Math.max(1, Math.floor(ttlSeconds))));
  } catch (err) {
    console.warn({ err, key }, 'Cache set error');
  }
}

/**
 * Closes Redis connection if it was opened. Useful for graceful shutdown or tests.
 */
export async function close(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
