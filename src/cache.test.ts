import { getCacheConfig, get, set, close } from './cache.js';

const originalEnv = process.env;

beforeEach(() => {
  jest.restoreAllMocks();
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('getCacheConfig', () => {
  it('should return mode off when CACHE_MODE is unset', () => {
    delete process.env.CACHE_MODE;
    expect(getCacheConfig().mode).toBe('off');
  });

  it('should return mode off when CACHE_MODE is invalid', () => {
    process.env.CACHE_MODE = 'memory';
    expect(getCacheConfig().mode).toBe('off');
  });

  it('should return mode redis when CACHE_MODE=redis', () => {
    process.env.CACHE_MODE = 'redis';
    process.env.CACHE_REDIS_URL = 'redis://localhost:6379';
    const config = getCacheConfig();
    expect(config.mode).toBe('redis');
    expect(config.redisUrl).toBe('redis://localhost:6379');
  });

  it('should return default TTLs when env not set', () => {
    delete process.env.CACHE_TTL_SUBTITLES_SECONDS;
    delete process.env.CACHE_TTL_METADATA_SECONDS;
    const config = getCacheConfig();
    expect(config.ttlSubtitlesSeconds).toBe(604800);
    expect(config.ttlMetadataSeconds).toBe(3600);
  });

  it('should read TTLs from env', () => {
    process.env.CACHE_TTL_SUBTITLES_SECONDS = '86400';
    process.env.CACHE_TTL_METADATA_SECONDS = '1800';
    const config = getCacheConfig();
    expect(config.ttlSubtitlesSeconds).toBe(86400);
    expect(config.ttlMetadataSeconds).toBe(1800);
  });
});

describe('get/set when CACHE_MODE=off', () => {
  it('get should return undefined', async () => {
    process.env.CACHE_MODE = 'off';
    await expect(get('any-key')).resolves.toBeUndefined();
  });

  it('set should resolve without error', async () => {
    process.env.CACHE_MODE = 'off';
    await expect(set('any-key', 'value', 3600)).resolves.toBeUndefined();
  });
});

describe('close', () => {
  it('should resolve without error when no client', async () => {
    await expect(close()).resolves.toBeUndefined();
  });
});
