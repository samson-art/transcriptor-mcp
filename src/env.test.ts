import { parseIntEnv, parseIntFromString } from './env.js';

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
