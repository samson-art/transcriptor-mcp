import {
  isMcpMetricsHttpRequestsByClientIpEnabled,
  parseIntEnv,
  parseIntFromString,
  parseMcpTrustProxyEnv,
} from './env.js';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('parseIntFromString', () => {
  it('returns parsed integer for valid string', () => {
    expect(parseIntFromString('42', 0)).toBe(42);
    expect(parseIntFromString('0', 99)).toBe(0);
    expect(parseIntFromString(' 123 ', 0)).toBe(123);
  });

  it('returns defaultValue for undefined', () => {
    expect(parseIntFromString(undefined, 100)).toBe(100);
  });

  it('returns defaultValue for empty string', () => {
    expect(parseIntFromString('', 50)).toBe(50);
  });

  it('returns defaultValue for invalid string (NaN)', () => {
    expect(parseIntFromString('abc', 77)).toBe(77);
    expect(parseIntFromString('--', 999)).toBe(999);
    expect(parseIntFromString('NaN', 5)).toBe(5);
  });
});

describe('parseIntEnv', () => {
  it('returns parsed integer when env var is set and valid', () => {
    process.env.TEST_PARSE_INT = '3000';
    expect(parseIntEnv('TEST_PARSE_INT', 8080)).toBe(3000);
  });

  it('returns defaultValue when env var is unset', () => {
    delete process.env.TEST_PARSE_INT;
    expect(parseIntEnv('TEST_PARSE_INT', 8080)).toBe(8080);
  });

  it('returns defaultValue when env var is empty', () => {
    process.env.TEST_PARSE_INT = '';
    expect(parseIntEnv('TEST_PARSE_INT', 8080)).toBe(8080);
  });

  it('returns defaultValue when env var is invalid (NaN)', () => {
    process.env.TEST_PARSE_INT = 'not-a-number';
    expect(parseIntEnv('TEST_PARSE_INT', 8080)).toBe(8080);
  });
});

describe('parseMcpTrustProxyEnv', () => {
  it('returns true when MCP_TRUST_PROXY is unset or empty', () => {
    delete process.env.MCP_TRUST_PROXY;
    expect(parseMcpTrustProxyEnv()).toBe(true);
    process.env.MCP_TRUST_PROXY = '';
    expect(parseMcpTrustProxyEnv()).toBe(true);
    process.env.MCP_TRUST_PROXY = '   ';
    expect(parseMcpTrustProxyEnv()).toBe(true);
  });

  it('returns false for 0, false, no, off', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'NO']) {
      process.env.MCP_TRUST_PROXY = v;
      expect(parseMcpTrustProxyEnv()).toBe(false);
    }
  });

  it('returns true for true, yes, on', () => {
    for (const v of ['true', 'yes', 'on', 'TRUE', 'YES']) {
      process.env.MCP_TRUST_PROXY = v;
      expect(parseMcpTrustProxyEnv()).toBe(true);
    }
  });

  it('returns a positive integer for decimal digit strings', () => {
    process.env.MCP_TRUST_PROXY = '1';
    expect(parseMcpTrustProxyEnv()).toBe(1);
    process.env.MCP_TRUST_PROXY = '3';
    expect(parseMcpTrustProxyEnv()).toBe(3);
  });

  it('returns false for numeric zero string', () => {
    process.env.MCP_TRUST_PROXY = '0';
    expect(parseMcpTrustProxyEnv()).toBe(false);
  });

  it('passes through other strings (e.g. proxy CIDR list)', () => {
    process.env.MCP_TRUST_PROXY = 'loopback, 10.0.0.0/8';
    expect(parseMcpTrustProxyEnv()).toBe('loopback, 10.0.0.0/8');
  });
});

describe('isMcpMetricsHttpRequestsByClientIpEnabled', () => {
  it('defaults to true when unset or empty', () => {
    delete process.env.MCP_METRICS_HTTP_REQUESTS_BY_CLIENT_IP;
    expect(isMcpMetricsHttpRequestsByClientIpEnabled()).toBe(true);
    process.env.MCP_METRICS_HTTP_REQUESTS_BY_CLIENT_IP = '';
    expect(isMcpMetricsHttpRequestsByClientIpEnabled()).toBe(true);
  });

  it('returns false for 0, false, no, off', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE']) {
      process.env.MCP_METRICS_HTTP_REQUESTS_BY_CLIENT_IP = v;
      expect(isMcpMetricsHttpRequestsByClientIpEnabled()).toBe(false);
    }
  });

  it('returns true for 1, true, yes', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      process.env.MCP_METRICS_HTTP_REQUESTS_BY_CLIENT_IP = v;
      expect(isMcpMetricsHttpRequestsByClientIpEnabled()).toBe(true);
    }
  });
});
