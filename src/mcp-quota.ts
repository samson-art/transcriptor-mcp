import { parseIntEnv, parseQuotaWindowMs } from './env.js';
import {
  hashPresentedApiKey,
  loadApiKeyRegistryFromProcessEnv,
  MCP_CLIENT_API_KEY_PEPPER_ENV,
  type ApiKeyRegistry,
} from './api-key-registry.js';
import { MemoryQuotaCounterStore, type QuotaIdentity } from './mcp-quota-store.js';
import {
  recordMcpQuotaCheck,
  recordMcpQuotaCheckDuration,
  recordMcpQuotaExceeded,
  recordMcpQuotaToolBlocked,
  type McpQuotaTier,
} from './metrics.js';
import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'mcp-quota',
});

const DEFAULT_CONTACT_MESSAGE =
  'You have exceeded the MCP tool call quota for this period. Contact the server operator to raise your limit.';

export type QuotaTier = McpQuotaTier;

/** Resolved limit after registry / default policy (ready for {@link checkQuota}). */
export type QuotaLimit = {
  maxToolCalls: number;
  windowMs: number;
  tier: QuotaTier;
  /** Registry `id` when `tier === 'registered'`. */
  keyId?: string;
  identity: QuotaIdentity;
};

export type QuotaResolution =
  | { type: 'skip' }
  | { type: 'rejected'; reason: 'no_key' | 'invalid_key'; tier: QuotaTier }
  | { type: 'ok'; limit: QuotaLimit };

let cachedRegistry: ApiKeyRegistry | null = null;
let quotaStore = new MemoryQuotaCounterStore();

export function resetMcpQuotaStateForTests(): void {
  cachedRegistry = null;
  quotaStore = new MemoryQuotaCounterStore();
}

function getRegistry(): ApiKeyRegistry {
  if (!cachedRegistry) {
    cachedRegistry = loadApiKeyRegistryFromProcessEnv();
  }
  return cachedRegistry;
}

export function isMcpQuotaEnabled(): boolean {
  const v = process.env.MCP_QUOTA_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function rejectUnregistered(): boolean {
  const v = process.env.MCP_QUOTA_REJECT_UNREGISTERED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getPepper(): string {
  return process.env[MCP_CLIENT_API_KEY_PEPPER_ENV]?.trim() ?? '';
}

function getContactMessage(): string {
  return process.env.MCP_QUOTA_CONTACT_MESSAGE?.trim() || DEFAULT_CONTACT_MESSAGE;
}

function messageForNoKey(): string {
  return (
    process.env.MCP_QUOTA_MESSAGE_NO_KEY?.trim() ||
    'This server requires a valid X-Api-Key. Contact the server operator for an API key.'
  );
}

function messageForInvalidKey(): string {
  return (
    process.env.MCP_QUOTA_MESSAGE_INVALID_KEY?.trim() ||
    'The provided API key is not valid. Contact the server operator.'
  );
}

function defaultMaxToolCalls(): number {
  return parseIntEnv('MCP_QUOTA_DEFAULT_MAX', 100);
}

function defaultWindowMs(): number {
  const spec = process.env.MCP_QUOTA_DEFAULT_WINDOW?.trim() || '24h';
  return parseQuotaWindowMs(spec);
}

/** @deprecated Use {@link parseQuotaWindowMs} from `./env.js` */
export const parseWindowToMs = parseQuotaWindowMs;

/**
 * Maps a client API key (or none) to a quota bucket and limits.
 * When MCP quota is disabled, returns `{ type: 'skip' }` so callers do not enforce.
 */
export function resolveLimit(apiKey: string | undefined): QuotaResolution {
  if (!isMcpQuotaEnabled()) {
    return { type: 'skip' };
  }

  const pepper = getPepper();
  const registry = getRegistry();
  const trimmed = apiKey?.trim() ?? '';
  const hasKey = trimmed.length > 0;

  if (hasKey) {
    const match = registry.lookup(trimmed);
    if (match) {
      return {
        type: 'ok',
        limit: {
          maxToolCalls: match.maxToolCalls,
          windowMs: match.windowMs,
          tier: 'registered',
          keyId: match.id,
          identity: {
            keyId: match.id,
            keyHashHex: hashPresentedApiKey(pepper, trimmed),
          },
        },
      };
    }
    if (rejectUnregistered()) {
      return { type: 'rejected', reason: 'invalid_key', tier: 'anonymous' };
    }
    return {
      type: 'ok',
      limit: {
        maxToolCalls: defaultMaxToolCalls(),
        windowMs: defaultWindowMs(),
        tier: 'default',
        identity: {
          keyId: 'default',
          keyHashHex: hashPresentedApiKey(pepper, `unknown:${trimmed}`),
        },
      },
    };
  }

  if (rejectUnregistered()) {
    return { type: 'rejected', reason: 'no_key', tier: 'anonymous' };
  }

  return {
    type: 'ok',
    limit: {
      maxToolCalls: defaultMaxToolCalls(),
      windowMs: defaultWindowMs(),
      tier: 'anonymous',
      identity: {
        keyId: 'default',
        keyHashHex: hashPresentedApiKey(pepper, '__mcp_quota_anonymous_v1__'),
      },
    },
  };
}

/**
 * Increments the quota counter and returns whether this tool call is within the limit.
 */
export async function checkQuota(limit: QuotaLimit): Promise<boolean> {
  const { count } = await quotaStore.increment(limit.identity, limit.windowMs);
  return count <= limit.maxToolCalls;
}

export type EnforceMcpToolQuotaResult = { allowed: true } | { allowed: false; message: string };

/**
 * Enforces quota for one MCP tool call: `resolveLimit` → `checkQuota`, metrics, user-facing messages.
 */
export async function enforceMcpToolQuota(
  toolName: string,
  getClientApiKey: (() => string | undefined) | undefined
): Promise<EnforceMcpToolQuotaResult> {
  if (!isMcpQuotaEnabled()) {
    return { allowed: true };
  }

  const t0 = performance.now();

  try {
    const apiKey = getClientApiKey?.();
    let resolution: QuotaResolution;
    try {
      resolution = resolveLimit(apiKey);
    } catch {
      log.error({ tool: toolName }, 'MCP quota: client API key registry configuration invalid');
      return {
        allowed: false,
        message: 'Server quota configuration is invalid (client API key registry).',
      };
    }

    if (resolution.type === 'skip') {
      return { allowed: true };
    }

    if (resolution.type === 'rejected') {
      const tier = resolution.tier;
      if (resolution.reason === 'no_key') {
        recordMcpQuotaCheck('rejected_no_key', tier);
      } else {
        recordMcpQuotaCheck('rejected_invalid_key', tier);
      }
      log.warn(
        { tool: toolName, reason: resolution.reason, tier },
        'MCP quota: request rejected (API key policy)'
      );
      return {
        allowed: false,
        message: resolution.reason === 'no_key' ? messageForNoKey() : messageForInvalidKey(),
      };
    }

    const { limit } = resolution;
    const allowed = await checkQuota(limit);

    if (allowed) {
      recordMcpQuotaCheck('allowed', limit.tier);
      return { allowed: true };
    }

    recordMcpQuotaCheck('exceeded', limit.tier);
    recordMcpQuotaExceeded(limit.tier, limit.keyId ?? 'none');
    recordMcpQuotaToolBlocked(toolName);
    log.warn(
      {
        tool: toolName,
        tier: limit.tier,
        keyId: limit.keyId ?? 'none',
        maxToolCalls: limit.maxToolCalls,
        windowMs: limit.windowMs,
      },
      'MCP quota exceeded: tool call blocked'
    );
    return {
      allowed: false,
      message: getContactMessage(),
    };
  } finally {
    const elapsed = (performance.now() - t0) / 1000;
    recordMcpQuotaCheckDuration(elapsed);
  }
}
