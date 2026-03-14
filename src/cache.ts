import Redis from 'ioredis';

import { parseIntEnv } from './env.js';

export type CacheMode = 'off' | 'redis';

/** Prefixes for cache key types. Used by buildCacheKey. */
export const CACHE_KEY_PREFIX = {
  sub: 'sub',
  avail: 'avail',
  info: 'info',
  chapters: 'chapters',
} as const;

export type CacheKeyType = keyof typeof CACHE_KEY_PREFIX;

/**
 * Builds a consistent cache key from type, URL, and optional parts.
 * Format: {prefix}:{url}[:part1][:part2][...]
 */
export function buildCacheKey(type: CacheKeyType, url: string, ...parts: string[]): string {
  const prefix = CACHE_KEY_PREFIX[type];
  const allParts = [url, ...parts].filter(Boolean);
  return `${prefix}:${allParts.join(':')}`;
}

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
  ping(): Promise<string>;
}

let redisClient: RedisLike | null = null;

let cachedConfig: CacheConfig | undefined;

function computeCacheConfig(): CacheConfig {
  const raw = process.env.CACHE_MODE?.trim().toLowerCase();
  const mode: CacheMode = raw === 'redis' ? 'redis' : 'off';

  const ttlSubtitles = parseIntEnv('CACHE_TTL_SUBTITLES_SECONDS', DEFAULT_TTL_SUBTITLES_SECONDS);
  const ttlMetadata = parseIntEnv('CACHE_TTL_METADATA_SECONDS', DEFAULT_TTL_METADATA_SECONDS);

  return {
    mode,
    redisUrl: process.env.CACHE_REDIS_URL?.trim(),
    ttlSubtitlesSeconds: ttlSubtitles,
    ttlMetadataSeconds: ttlMetadata,
  };
}

/**
 * Reads cache configuration from environment.
 * Cached as lazy singleton since env vars do not change at runtime.
 * Exported for testing.
 */
export function getCacheConfig(): CacheConfig {
  cachedConfig ??= computeCacheConfig();
  return cachedConfig;
}

/**
 * Resets the cached config. For testing only; allows tests to exercise different env values.
 */
export function resetCacheConfigForTests(): void {
  cachedConfig = undefined;
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
 * Pings Redis. Returns true if cache is off or Redis is reachable, false if Redis is configured but unreachable.
 */
export async function ping(): Promise<boolean> {
  const config = getCacheConfig();
  if (config.mode !== 'redis') {
    return true;
  }
  const client = getRedisClient();
  if (!client) {
    return true;
  }
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes Redis connection if it was opened. Useful for graceful shutdown or tests.
 */
export async function close(): Promise<void> {
  if (!redisClient) {
    return;
  }
  const client = redisClient;
  redisClient = null;
  try {
    await client.quit();
  } catch (err) {
    console.warn({ err }, 'Redis quit error during close');
  }
}
