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
