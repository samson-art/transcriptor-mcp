import {
  getCacheConfig,
  get,
  set,
  close,
  ping,
  resetCacheConfigForTests,
  buildCacheKey,
  CACHE_KEY_PREFIX,
} from './cache.js';

const originalEnv = process.env;

beforeEach(() => {
  jest.restoreAllMocks();
  process.env = { ...originalEnv };
  resetCacheConfigForTests();
});

afterAll(() => {
  process.env = originalEnv;
});

describe('buildCacheKey', () => {
  it('should build avail key', () => {
    expect(buildCacheKey('avail', 'https://youtube.com/watch?v=abc')).toBe(
      'avail:https://youtube.com/watch?v=abc'
    );
  });

  it('should build info key', () => {
    expect(buildCacheKey('info', 'https://youtube.com/watch?v=xyz')).toBe(
      'info:https://youtube.com/watch?v=xyz'
    );
  });

  it('should build chapters key', () => {
    expect(buildCacheKey('chapters', 'https://youtube.com/watch?v=123')).toBe(
      'chapters:https://youtube.com/watch?v=123'
    );
  });

  it('should build sub key with auto-discovery', () => {
    expect(buildCacheKey('sub', 'https://youtube.com/watch?v=abc', 'auto-discovery', 'srt')).toBe(
      'sub:https://youtube.com/watch?v=abc:auto-discovery:srt'
    );
  });

  it('should build sub key with type, lang, format', () => {
    expect(
      buildCacheKey('sub', 'https://youtube.com/watch?v=abc', 'official', 'en', 'default')
    ).toBe('sub:https://youtube.com/watch?v=abc:official:en:default');
  });

  it('should have consistent CACHE_KEY_PREFIX values', () => {
    expect(CACHE_KEY_PREFIX).toEqual({
      sub: 'sub',
      avail: 'avail',
      info: 'info',
      chapters: 'chapters',
    });
  });
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

describe('ping', () => {
  it('should return true when CACHE_MODE is off', async () => {
    process.env.CACHE_MODE = 'off';
    await expect(ping()).resolves.toBe(true);
  });

  it('should return true when CACHE_MODE=redis but CACHE_REDIS_URL is unset', async () => {
    process.env.CACHE_MODE = 'redis';
    delete process.env.CACHE_REDIS_URL;
    await expect(ping()).resolves.toBe(true);
  });
});

describe('close', () => {
  it('should resolve without error when no client', async () => {
    await expect(close()).resolves.toBeUndefined();
  });
});
