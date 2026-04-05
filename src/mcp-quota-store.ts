export type QuotaIncrementResult = {
  count: number;
  /** TTL seconds Redis applied (best effort) */
  ttlSeconds?: number;
};

/**
 * Identity for quota counters: registry id (or `default`) plus hex hash of client key material.
 * Redis keys never contain raw API keys.
 */
export type QuotaIdentity = {
  keyId: string;
  keyHashHex: string;
};

export interface QuotaCounterStore {
  /**
   * Increments the counter for this identity in the current fixed window bucket.
   * Returns the new count after increment.
   */
  increment(
    identity: QuotaIdentity,
    windowMs: number,
    nowMs?: number
  ): Promise<QuotaIncrementResult>;
}

/** Prefix for quota keys; distinct from subtitle cache. */
export const QUOTA_REDIS_KEY_PREFIX = 'mcp:quota:v1';

const MAX_KEY_ID_LEN = 128;
const MAX_HASH_HEX_LEN = 128;

function sanitizeKeyId(id: string): string {
  if (id.length === 0 || id.length > MAX_KEY_ID_LEN) {
    return 'invalid';
  }
  const s = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return s.length > 0 ? s : 'invalid';
}

function truncateHashHex(hex: string): string {
  if (hex.length <= MAX_HASH_HEX_LEN) {
    return hex;
  }
  return hex.slice(0, MAX_HASH_HEX_LEN);
}

/**
 * Storage key for one fixed-window bucket (Redis or in-memory). Includes registry id
 * (or `default`), key hash, window size, and bucket index.
 */
export function buildQuotaStorageKey(
  identity: QuotaIdentity,
  windowMs: number,
  nowMs: number
): string {
  const bucket = Math.floor(nowMs / windowMs);
  const safeId = sanitizeKeyId(identity.keyId);
  const hash = truncateHashHex(identity.keyHashHex);
  return `${QUOTA_REDIS_KEY_PREFIX}:${safeId}:${hash}:w${windowMs}:b${bucket}`;
}

function windowTtlMs(windowMs: number, nowMs: number): number {
  const bucket = Math.floor(nowMs / windowMs);
  const windowEnd = (bucket + 1) * windowMs;
  return Math.max(1, windowEnd - nowMs);
}

/** Atomic INCR; on first increment sets PEXPIRE to the rest of the fixed window. */
const REDIS_QUOTA_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return v
`;

/**
 * In-memory fixed-window buckets. Suitable for single-process / tests.
 */
export class MemoryQuotaCounterStore implements QuotaCounterStore {
  private readonly counts = new Map<string, number>();

  increment(
    identity: QuotaIdentity,
    windowMs: number,
    nowMs?: number
  ): Promise<QuotaIncrementResult> {
    const now = nowMs ?? Date.now();
    const key = buildQuotaStorageKey(identity, windowMs, now);
    const prev = this.counts.get(key) ?? 0;
    const count = prev + 1;
    this.counts.set(key, count);
    this.pruneOldBuckets(identity, windowMs, now);
    return Promise.resolve({ count });
  }

  private pruneOldBuckets(identity: QuotaIdentity, windowMs: number, nowMs: number): void {
    const currentBucket = Math.floor(nowMs / windowMs);
    const prefix = `${QUOTA_REDIS_KEY_PREFIX}:${sanitizeKeyId(identity.keyId)}:${truncateHashHex(identity.keyHashHex)}:w${windowMs}:b`;
    for (const k of this.counts.keys()) {
      if (!k.startsWith(prefix)) {
        continue;
      }
      const bStr = k.slice(prefix.length);
      const b = Number.parseInt(bStr, 10);
      if (Number.isFinite(b) && b < currentBucket) {
        this.counts.delete(k);
      }
    }
  }
}

type RedisQuotaClient = {
  eval(script: string, numKeys: number, ...args: (string | Buffer)[]): Promise<unknown>;
};

/**
 * Redis fixed window: Lua INCR + PEXPIRE for the remainder of the bucket.
 */
export class RedisQuotaCounterStore implements QuotaCounterStore {
  constructor(private readonly redis: RedisQuotaClient) {}

  async increment(
    identity: QuotaIdentity,
    windowMs: number,
    nowMs?: number
  ): Promise<QuotaIncrementResult> {
    const now = nowMs ?? Date.now();
    const key = buildQuotaStorageKey(identity, windowMs, now);
    const ttlMs = windowTtlMs(windowMs, now);

    const raw = await this.redis.eval(REDIS_QUOTA_LUA, 1, key, String(ttlMs));
    const count = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(count)) {
      throw new Error('quota redis INCR returned non-numeric value');
    }

    const ttlSeconds = Math.ceil(ttlMs / 1000);
    return { count, ttlSeconds };
  }
}
