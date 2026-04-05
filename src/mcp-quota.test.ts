import {
  computeSecretHashHex,
  hashPresentedApiKey,
  MCP_CLIENT_API_KEY_PEPPER_ENV,
} from './api-key-registry.js';
import {
  enforceMcpToolQuota,
  isMcpQuotaEnabled,
  parseWindowToMs,
  resetMcpQuotaStateForTests,
  resolveLimit,
  checkQuota,
  type QuotaLimit,
} from './mcp-quota.js';
import { renderPrometheus, resetMetricsRegistryForTests } from './metrics.js';

describe('mcp-quota', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetMcpQuotaStateForTests();
    resetMetricsRegistryForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseWindowToMs', () => {
    it('parses common units', () => {
      expect(parseWindowToMs('1ms')).toBe(1);
      expect(parseWindowToMs('2s')).toBe(2000);
      expect(parseWindowToMs('5m')).toBe(300_000);
      expect(parseWindowToMs('24h')).toBe(86_400_000);
      expect(parseWindowToMs('1d')).toBe(86_400_000);
    });

    it('throws on invalid spec', () => {
      expect(() => parseWindowToMs('')).toThrow();
      expect(() => parseWindowToMs('24hours')).toThrow();
    });
  });

  describe('resolveLimit', () => {
    it('returns skip when quota disabled', () => {
      delete process.env.MCP_QUOTA_ENABLED;
      expect(resolveLimit(undefined)).toEqual({ type: 'skip' });
    });

    it('applies default anonymous policy when enabled and no key', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_DEFAULT_MAX = '50';
      process.env.MCP_QUOTA_DEFAULT_WINDOW = '1h';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;
      delete process.env.MCP_QUOTA_REJECT_UNREGISTERED;

      const r = resolveLimit(undefined);
      expect(r.type).toBe('ok');
      if (r.type === 'ok') {
        expect(r.limit.tier).toBe('anonymous');
        expect(r.limit.identity.keyId).toBe('default');
        expect(r.limit.maxToolCalls).toBe(50);
        expect(r.limit.windowMs).toBe(3_600_000);
        expect(r.limit.identity.keyHashHex).toBe(
          hashPresentedApiKey('', '__mcp_quota_anonymous_v1__')
        );
      }
    });

    it('uses distinct anonymous buckets for different material', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = 'pepper-anon';
      delete process.env.MCP_QUOTA_REJECT_UNREGISTERED;
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      const r1 = resolveLimit(undefined, '192.168.0.1');
      const r2 = resolveLimit(undefined, '192.168.0.2');
      const rGlobal = resolveLimit(undefined);
      expect(r1.type).toBe('ok');
      expect(r2.type).toBe('ok');
      expect(rGlobal.type).toBe('ok');
      if (r1.type === 'ok' && r2.type === 'ok' && rGlobal.type === 'ok') {
        expect(r1.limit.identity.keyHashHex).toBe(
          hashPresentedApiKey('pepper-anon', 'anon:192.168.0.1')
        );
        expect(r2.limit.identity.keyHashHex).toBe(
          hashPresentedApiKey('pepper-anon', 'anon:192.168.0.2')
        );
        expect(r1.limit.identity.keyHashHex).not.toBe(r2.limit.identity.keyHashHex);
        expect(rGlobal.limit.identity.keyHashHex).toBe(
          hashPresentedApiKey('pepper-anon', '__mcp_quota_anonymous_v1__')
        );
      }
    });

    it('treats blank anonymous material like no material (global bucket)', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = 'p';
      delete process.env.MCP_QUOTA_REJECT_UNREGISTERED;
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      expect(resolveLimit(undefined, '  \t')).toEqual(resolveLimit(undefined));
    });

    it('matches registered secret and uses registry limits', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      const pepper = 'test-pepper-registry';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = pepper;
      const secret = 'sk_test_abc';
      const secretHash = computeSecretHashHex(pepper, secret);
      process.env.MCP_CLIENT_API_KEYS_JSON = JSON.stringify([
        { id: 'paid', secretHash, maxToolCalls: 3, window: '1h' },
      ]);

      const r = resolveLimit(secret);
      expect(r.type).toBe('ok');
      if (r.type === 'ok') {
        expect(r.limit.tier).toBe('registered');
        expect(r.limit.keyId).toBe('paid');
        expect(r.limit.maxToolCalls).toBe(3);
      }
    });

    it('rejects missing key when MCP_QUOTA_REJECT_UNREGISTERED', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_REJECT_UNREGISTERED = 'true';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      const r = resolveLimit(undefined);
      expect(r.type).toBe('rejected');
      if (r.type === 'rejected') {
        expect(r.reason).toBe('no_key');
      }
    });

    it('rejects unknown key when MCP_QUOTA_REJECT_UNREGISTERED', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_REJECT_UNREGISTERED = 'true';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = 'p';
      const knownHash = computeSecretHashHex('p', 'known');
      process.env.MCP_CLIENT_API_KEYS_JSON = JSON.stringify([
        { id: 'a', secretHash: knownHash, maxToolCalls: 1, window: '1h' },
      ]);

      const r = resolveLimit('wrong');
      expect(r.type).toBe('rejected');
      if (r.type === 'rejected') {
        expect(r.reason).toBe('invalid_key');
      }
    });

    it('falls back to default tier for unknown key when reject is off', () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = 'p';
      delete process.env.MCP_QUOTA_REJECT_UNREGISTERED;
      const knownHash = computeSecretHashHex('p', 'known');
      process.env.MCP_CLIENT_API_KEYS_JSON = JSON.stringify([
        { id: 'a', secretHash: knownHash, maxToolCalls: 1, window: '1h' },
      ]);

      const r = resolveLimit('unknown-key');
      expect(r.type).toBe('ok');
      if (r.type === 'ok') {
        expect(r.limit.tier).toBe('default');
        expect(r.limit.identity.keyId).toBe('default');
      }
    });
  });

  describe('checkQuota', () => {
    it('allows up to maxToolCalls then blocks', async () => {
      const limit: QuotaLimit = {
        maxToolCalls: 2,
        windowMs: 60_000,
        tier: 'default',
        identity: { keyId: 'test', keyHashHex: 'aa'.repeat(32) },
      };
      expect(await checkQuota(limit)).toBe(true);
      expect(await checkQuota(limit)).toBe(true);
      expect(await checkQuota(limit)).toBe(false);
    });
  });

  describe('enforceMcpToolQuota', () => {
    it('allows all when quota disabled', async () => {
      delete process.env.MCP_QUOTA_ENABLED;
      const r = await enforceMcpToolQuota('search_videos', () => 'any');
      expect(r.allowed).toBe(true);
    });

    it('blocks after default max is exhausted', async () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_DEFAULT_MAX = '2';
      process.env.MCP_QUOTA_DEFAULT_WINDOW = '24h';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      const getKey = () => undefined;
      expect((await enforceMcpToolQuota('search_videos', getKey)).allowed).toBe(true);
      expect((await enforceMcpToolQuota('search_videos', getKey)).allowed).toBe(true);
      const last = await enforceMcpToolQuota('search_videos', getKey);
      expect(last.allowed).toBe(false);
      if (last.allowed === false) {
        expect(last.message).toContain('operator');
      }
    });

    it('uses separate anonymous buckets when getAnonymousQuotaMaterial differs', async () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_DEFAULT_MAX = '1';
      process.env.MCP_QUOTA_DEFAULT_WINDOW = '24h';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      const callA = () =>
        enforceMcpToolQuota(
          'search_videos',
          () => undefined,
          () => 'client-a'
        );
      const callB = () =>
        enforceMcpToolQuota(
          'search_videos',
          () => undefined,
          () => 'client-b'
        );

      expect((await callA()).allowed).toBe(true);
      expect((await callA()).allowed).toBe(false);
      expect((await callB()).allowed).toBe(true);
      expect((await callB()).allowed).toBe(false);
    });

    it('stdio (no anonymous material resolver): global bucket is separate from per-material HTTP', async () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_DEFAULT_MAX = '1';
      process.env.MCP_QUOTA_DEFAULT_WINDOW = '24h';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      expect(
        (
          await enforceMcpToolQuota(
            'search_videos',
            () => undefined,
            () => 'by-ip'
          )
        ).allowed
      ).toBe(true);
      expect(
        (
          await enforceMcpToolQuota(
            'search_videos',
            () => undefined,
            () => 'by-ip'
          )
        ).allowed
      ).toBe(false);

      expect((await enforceMcpToolQuota('search_videos', () => undefined)).allowed).toBe(true);
      expect((await enforceMcpToolQuota('search_videos', () => undefined)).allowed).toBe(false);
    });

    it('uses separate buckets for two registered keys', async () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = 'pepper-two-keys';
      const h1 = computeSecretHashHex('pepper-two-keys', 'aaa');
      const h2 = computeSecretHashHex('pepper-two-keys', 'bbb');
      process.env.MCP_CLIENT_API_KEYS_JSON = JSON.stringify([
        { id: 'k1', secretHash: h1, maxToolCalls: 1, window: '24h' },
        { id: 'k2', secretHash: h2, maxToolCalls: 1, window: '24h' },
      ]);

      expect((await enforceMcpToolQuota('search_videos', () => 'aaa')).allowed).toBe(true);
      expect((await enforceMcpToolQuota('search_videos', () => 'aaa')).allowed).toBe(false);

      resetMetricsRegistryForTests();

      expect((await enforceMcpToolQuota('search_videos', () => 'bbb')).allowed).toBe(true);
      expect((await enforceMcpToolQuota('search_videos', () => 'bbb')).allowed).toBe(false);
    });
  });

  describe('metrics export', () => {
    it('records mcp_quota_* samples in Prometheus text', async () => {
      process.env.MCP_QUOTA_ENABLED = '1';
      process.env.MCP_QUOTA_DEFAULT_MAX = '1';
      process.env.MCP_QUOTA_DEFAULT_WINDOW = '24h';
      delete process.env.MCP_CLIENT_API_KEYS_JSON;

      expect((await enforceMcpToolQuota('get_video_info', () => undefined)).allowed).toBe(true);
      expect((await enforceMcpToolQuota('get_video_info', () => undefined)).allowed).toBe(false);

      const text = await renderPrometheus();
      expect(text).toContain('mcp_quota_checks_total');
      expect(text).toContain('mcp_quota_exceeded_total');
      expect(text).toContain('mcp_quota_tool_calls_blocked_total');
      expect(text).toContain('mcp_quota_check_duration_seconds');
    });
  });

  describe('isMcpQuotaEnabled', () => {
    it('reflects MCP_QUOTA_ENABLED', () => {
      delete process.env.MCP_QUOTA_ENABLED;
      expect(isMcpQuotaEnabled()).toBe(false);
      process.env.MCP_QUOTA_ENABLED = 'true';
      expect(isMcpQuotaEnabled()).toBe(true);
    });
  });
});
