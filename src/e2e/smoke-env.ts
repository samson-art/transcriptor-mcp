export function getEnvVar(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : defaultValue;
}

/** True when the env var is set to one of the accepted "on" spellings. */
export function isFlagSet(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}
