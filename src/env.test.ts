import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('.env.example', () => {
  // Nothing compared the file with the code, and five variables went missing until 1.5.9.
  it('mentions every env var that non-test src/ reads', () => {
    const example = readFileSync('.env.example', 'utf-8');
    const names = new Set<string>();
    for (const file of readdirSync('src', { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.startsWith('e2e/')) continue;
      const code = readFileSync(join('src', file), 'utf-8');
      for (const [, name] of code.matchAll(/(?:process\.env\.|Env\(\s*')([A-Z0-9_]+)/g)) {
        names.add(name);
      }
    }

    expect([...names]).toEqual(expect.arrayContaining(['YT_DLP_NO_WARNINGS', 'YT_DLP_TIMEOUT']));
    expect([...names].filter((name) => !new RegExp(`\\b${name}\\b`).test(example))).toEqual([]);
  });
});
