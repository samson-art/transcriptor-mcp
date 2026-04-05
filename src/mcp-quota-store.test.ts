import {
  MemoryQuotaCounterStore,
  QUOTA_REDIS_KEY_PREFIX,
  RedisQuotaCounterStore,
  buildQuotaStorageKey,
} from './mcp-quota-store.js';

const evalMock = jest.fn().mockResolvedValue(2);

describe('buildQuotaStorageKey', () => {
  it('includes prefix, sanitized keyId, hash, window, and bucket', () => {
    const k = buildQuotaStorageKey({ keyId: 'client_a', keyHashHex: 'deadbeef' }, 60_000, 90_000);
    expect(k).toBe(`${QUOTA_REDIS_KEY_PREFIX}:client_a:deadbeef:w60000:b1`);
  });

  it('uses bucket 0 at start of timeline', () => {
    const k = buildQuotaStorageKey({ keyId: 'default', keyHashHex: 'ab' }, 60_000, 0);
    expect(k.endsWith(':b0')).toBe(true);
  });

  it('sanitizes unsafe keyId characters', () => {
    const k = buildQuotaStorageKey({ keyId: 'a:b', keyHashHex: 'x' }, 1000, 0);
    expect(k).toContain(':a_b:');
  });
});

describe('MemoryQuotaCounterStore', () => {
  it('counts per identity until max behavior is enforced by caller', async () => {
    const store = new MemoryQuotaCounterStore();
    const id = { keyId: 'reg1', keyHashHex: 'aa' };
    await expect(store.increment(id, 60_000, 5000)).resolves.toEqual({ count: 1 });
    await expect(store.increment(id, 60_000, 5000)).resolves.toEqual({ count: 2 });
    await store.increment({ keyId: 'reg2', keyHashHex: 'aa' }, 60_000, 5000);
    await expect(
      store.increment({ keyId: 'reg2', keyHashHex: 'aa' }, 60_000, 5000)
    ).resolves.toEqual({
      count: 2,
    });
  });

  it('resets in the next window bucket', async () => {
    const store = new MemoryQuotaCounterStore();
    const id = { keyId: 'default', keyHashHex: 'bb' };
    await store.increment(id, 1000, 100);
    await store.increment(id, 1000, 100);
    await expect(store.increment(id, 1000, 100)).resolves.toEqual({ count: 3 });
    await expect(store.increment(id, 1000, 1200)).resolves.toEqual({ count: 1 });
  });
});

describe('RedisQuotaCounterStore', () => {
  beforeEach(() => {
    evalMock.mockClear();
    evalMock.mockResolvedValue(2);
  });

  it('runs Lua INCR with key containing id and hash', async () => {
    const store = new RedisQuotaCounterStore({ eval: evalMock } as never);
    await store.increment({ keyId: 'paid', keyHashHex: 'cafe' }, 60_000, 10_000);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const call = evalMock.mock.calls[0];
    expect(call[1]).toBe(1);
    expect(call[2]).toContain(`${QUOTA_REDIS_KEY_PREFIX}:paid:cafe:w60000:b0`);
  });
});
