import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeSecretHashHex,
  loadApiKeyRegistryFromFile,
  loadApiKeyRegistryFromProcessEnv,
  MCP_CLIENT_API_KEYS_FILE_ENV,
  MCP_CLIENT_API_KEYS_JSON_ENV,
  MCP_CLIENT_API_KEY_PEPPER_ENV,
  parseApiKeyRegistryJson,
  parseQuotaWindow,
} from './api-key-registry.js';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('parseQuotaWindow', () => {
  it('parses compact units', () => {
    expect(parseQuotaWindow('24h')).toBe(24 * 3_600_000);
    expect(parseQuotaWindow('1h')).toBe(3_600_000);
    expect(parseQuotaWindow('30m')).toBe(30 * 60_000);
    expect(parseQuotaWindow('7d')).toBe(7 * 86_400_000);
    expect(parseQuotaWindow('100ms')).toBe(100);
  });

  it('parses spaced and word units', () => {
    expect(parseQuotaWindow('1 minute')).toBe(60_000);
    expect(parseQuotaWindow('2 hours')).toBe(2 * 3_600_000);
  });

  it('throws on empty or invalid', () => {
    expect(() => {
      parseQuotaWindow('');
    }).toThrow();
    expect(() => {
      parseQuotaWindow('   ');
    }).toThrow();
    expect(() => {
      parseQuotaWindow('0h');
    }).toThrow();
    expect(() => {
      parseQuotaWindow('foo');
    }).toThrow();
  });
});

describe('parseApiKeyRegistryJson', () => {
  const pepper = 'test-pepper-xyz';
  const secret = 'sk_test_abc123';
  const hash = computeSecretHashHex(pepper, secret);

  it('loads a valid key and verifies with lookup', () => {
    const json = JSON.stringify([
      {
        id: 'k1',
        secretHash: hash,
        maxToolCalls: 10,
        window: '1h',
        label: 'Test',
      },
    ]);
    const reg = parseApiKeyRegistryJson(json, pepper);
    expect(reg.size).toBe(1);
    expect(reg.lookup(secret)).toEqual({
      id: 'k1',
      maxToolCalls: 10,
      windowMs: 3_600_000,
      label: 'Test',
    });
    expect(reg.lookup('wrong')).toBeNull();
    expect(reg.lookup('')).toBeNull();
    expect(reg.lookup(undefined)).toBeNull();
  });

  it('accepts maxCalls alias', () => {
    const json = JSON.stringify([
      {
        id: 'k2',
        secretHash: hash,
        maxCalls: 5,
        window: '24h',
      },
    ]);
    const reg = parseApiKeyRegistryJson(json, pepper);
    expect(reg.lookup(secret)?.maxToolCalls).toBe(5);
  });

  it('rejects duplicate id', () => {
    const json = JSON.stringify([
      { id: 'dup', secretHash: hash, maxToolCalls: 1, window: '1h' },
      { id: 'dup', secretHash: hash, maxToolCalls: 2, window: '1h' },
    ]);
    expect(() => parseApiKeyRegistryJson(json, pepper)).toThrow(/duplicate API key registry id/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseApiKeyRegistryJson('not json', pepper)).toThrow(/invalid JSON/);
  });

  it('verifies prefix + secret suffix', () => {
    const suffix = 'mysecretpart';
    const fullKey = `tk_live_${suffix}`;
    const suffixHash = computeSecretHashHex(pepper, suffix);
    const json = JSON.stringify([
      {
        id: 'pref',
        prefix: 'tk_live_',
        secretHash: suffixHash,
        maxToolCalls: 100,
        window: '24h',
      },
    ]);
    const reg = parseApiKeyRegistryJson(json, pepper);
    expect(reg.lookup(fullKey)?.id).toBe('pref');
    expect(reg.lookup('tk_live_')).toBeNull();
    expect(reg.lookup('other_mysecretpart')).toBeNull();
  });
});

describe('loadApiKeyRegistryFromProcessEnv', () => {
  it('returns empty registry when no env', () => {
    delete process.env[MCP_CLIENT_API_KEYS_JSON_ENV];
    delete process.env[MCP_CLIENT_API_KEYS_FILE_ENV];
    const reg = loadApiKeyRegistryFromProcessEnv();
    expect(reg.size).toBe(0);
    expect(reg.lookup('anything')).toBeNull();
  });

  it('loads from JSON env', () => {
    const pepper = 'p';
    process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = pepper;
    const secret = 'keyenv';
    const h = computeSecretHashHex(pepper, secret);
    process.env[MCP_CLIENT_API_KEYS_JSON_ENV] = JSON.stringify([
      { id: 'env1', secretHash: h, maxToolCalls: 3, window: '1m' },
    ]);
    delete process.env[MCP_CLIENT_API_KEYS_FILE_ENV];
    const reg = loadApiKeyRegistryFromProcessEnv();
    expect(reg.lookup(secret)?.id).toBe('env1');
  });

  it('prefers file over inline JSON when both set', () => {
    const pepper = 'p';
    process.env[MCP_CLIENT_API_KEY_PEPPER_ENV] = pepper;
    const fileSecret = 'fromfile';
    const inlineSecret = 'frominline';
    const fileHash = computeSecretHashHex(pepper, fileSecret);
    const tmp = join(tmpdir(), `mcp-keys-${Date.now()}.json`);
    writeFileSync(
      tmp,
      JSON.stringify([{ id: 'f', secretHash: fileHash, maxToolCalls: 1, window: '1h' }]),
      'utf8'
    );
    try {
      process.env[MCP_CLIENT_API_KEYS_FILE_ENV] = tmp;
      process.env[MCP_CLIENT_API_KEYS_JSON_ENV] = JSON.stringify([
        {
          id: 'i',
          secretHash: computeSecretHashHex(pepper, inlineSecret),
          maxToolCalls: 1,
          window: '1h',
        },
      ]);
      const reg = loadApiKeyRegistryFromProcessEnv();
      expect(reg.lookup(fileSecret)?.id).toBe('f');
      expect(reg.lookup(inlineSecret)).toBeNull();
    } finally {
      unlinkSync(tmp);
    }
  });
});

describe('loadApiKeyRegistryFromFile', () => {
  it('reads UTF-8 file', () => {
    const pepper = 'p2';
    const secret = 'filekey';
    const h = computeSecretHashHex(pepper, secret);
    const tmp = join(tmpdir(), `mcp-keys-file-${Date.now()}.json`);
    writeFileSync(
      tmp,
      JSON.stringify([{ id: 'file', secretHash: h, maxCalls: 2, window: '30m' }]),
      'utf8'
    );
    try {
      const reg = loadApiKeyRegistryFromFile(tmp, pepper);
      expect(reg.lookup(secret)?.maxToolCalls).toBe(2);
    } finally {
      unlinkSync(tmp);
    }
  });
});

describe('timingSafeEqual behavior', () => {
  it('does not match a different secret with same pepper', () => {
    const pepper = 'pepper';
    const a = computeSecretHashHex(pepper, 'secret-a');
    const b = computeSecretHashHex(pepper, 'secret-b');
    expect(a).not.toBe(b);
    const json = JSON.stringify([{ id: 'a', secretHash: a, maxToolCalls: 1, window: '1h' }]);
    const reg = parseApiKeyRegistryJson(json, pepper);
    expect(reg.lookup('secret-a')).not.toBeNull();
    expect(reg.lookup('secret-b')).toBeNull();
  });
});
