import { AsyncLocalStorage } from 'node:async_hooks';

export type McpRequestContext = {
  clientApiKey?: string;
  /** Normalized client IP (or equivalent) for per-anonymous-client quota; not a raw log line. */
  anonymousQuotaMaterial?: string;
};

const storage = new AsyncLocalStorage<McpRequestContext>();

export function runWithMcpRequestContext<T>(ctx: McpRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getMcpRequestContext(): McpRequestContext | undefined {
  return storage.getStore();
}
