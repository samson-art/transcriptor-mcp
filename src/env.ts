/**
 * Parses a string as an integer, returning defaultValue if the result is NaN.
 */
export function parseIntFromString(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parses an environment variable as an integer, returning defaultValue if
 * the variable is unset, empty, or does not parse to a finite number.
 */
export function parseIntEnv(name: string, defaultValue: number): number {
  return parseIntFromString(process.env[name], defaultValue);
}

/**
 * Parses duration strings for MCP quota windows (env defaults and registry `window` fields).
 * Supported: compact units (100ms, 5s, 30m, 24h, 7d) and phrases (1 minute, 2 hours).
 */
export function parseQuotaWindowMs(spec: string): number {
  const s = spec.trim().toLowerCase();
  if (!s) {
    throw new Error('empty quota window');
  }

  const compact = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s);
  if (compact) {
    const n = Number(compact[1]);
    if (n === 0) {
      throw new Error('quota window must be positive');
    }
    const u = compact[2];
    const mult: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return n * mult[u];
  }

  const words = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/.exec(s);
  if (words) {
    const n = Number(words[1]);
    if (n === 0) {
      throw new Error('quota window must be positive');
    }
    const w = words[2];
    if (w.startsWith('minute')) {
      return n * 60_000;
    }
    if (w.startsWith('hour')) {
      return n * 3_600_000;
    }
    if (w.startsWith('day')) {
      return n * 86_400_000;
    }
  }

  throw new Error(`Invalid quota window: ${spec}`);
}
