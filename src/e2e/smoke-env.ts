export function getEnvVar(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : defaultValue;
}
