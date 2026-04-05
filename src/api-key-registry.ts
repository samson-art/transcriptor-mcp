import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { parseQuotaWindowMs } from './env.js';

/** Env: JSON array of client API key records (Docker/K8s secrets). */
export const MCP_CLIENT_API_KEYS_JSON_ENV = 'MCP_CLIENT_API_KEYS_JSON';
/** Env: path to a JSON file with the same shape as {@link MCP_CLIENT_API_KEYS_JSON_ENV}. */
export const MCP_CLIENT_API_KEYS_FILE_ENV = 'MCP_CLIENT_API_KEYS_FILE';
/**
 * Env: pepper mixed into the hash (use a long random value in production).
 * Same formula as MCP quota: sha256(`${pepper}:${secretMaterial}`) hex.
 */
export const MCP_CLIENT_API_KEY_PEPPER_ENV = 'MCP_CLIENT_API_KEY_PEPPER';

const RawRegistryEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    /** Lowercase hex SHA-256 of hashPresentedApiKey(pepper, material); material is full key or suffix after prefix. */
    secretHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    /** If set, only the part after this prefix is hashed and compared. */
    prefix: z.string().min(1).max(256).optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxCalls: z.number().int().positive().optional(),
    /** Duration string, e.g. 24h, 1h, 30m, 7d, 1 minute */
    window: z.string().min(1).max(64),
    label: z.string().max(256).optional(),
  })
  .superRefine((data, ctx) => {
    const max = data.maxToolCalls ?? data.maxCalls;
    if (max === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either maxToolCalls or maxCalls is required',
        path: ['maxToolCalls'],
      });
    }
  });

const RawRegistrySchema = z.array(RawRegistryEntrySchema);

/** Re-export shared quota window parser (used in tests and docs). */
export { parseQuotaWindowMs as parseQuotaWindow } from './env.js';

function digestSecretForLookup(pepper: string, secretMaterial: string): Buffer {
  return createHash('sha256').update(`${pepper}:${secretMaterial}`, 'utf8').digest();
}

/**
 * Hex digest used for registry JSON `secretHash` and for MCP quota `byHash` lookup keys.
 * Matches {@link ./mcp-quota-registry.js} `hashClientApiKey` when material is the presented API key (or suffix).
 */
export function hashPresentedApiKey(pepper: string, rawKey: string): string {
  return digestSecretForLookup(pepper, rawKey).toString('hex');
}

/**
 * Computes the hex secretHash stored in the registry for a given secret material (full API key or suffix after prefix).
 * Same as {@link hashPresentedApiKey}.
 */
export function computeSecretHashHex(pepper: string, secretMaterial: string): string {
  return hashPresentedApiKey(pepper, secretMaterial);
}

function hexToBuffer32(hex: string): Buffer {
  const normalized = hex.trim().toLowerCase();
  return Buffer.from(normalized, 'hex');
}

export type ApiKeyRegistryEntry = {
  id: string;
  maxToolCalls: number;
  /** Resolved duration in milliseconds */
  windowMs: number;
  label?: string;
};

/** Snapshot for MCP quota enforcement (map lookup by pepper-based hash). */
export type ClientApiKeyRegistry = {
  entries: ApiKeyRegistryEntry[];
  /** Map key: {@link hashPresentedApiKey}(pepper, presentedKey) */
  byHash: Map<string, ApiKeyRegistryEntry>;
};

type InternalEntry = ApiKeyRegistryEntry & {
  expectedHash: Buffer;
  prefix: string | null;
};

function buildInternalEntry(raw: z.infer<typeof RawRegistryEntrySchema>): InternalEntry {
  const maxToolCalls = raw.maxToolCalls ?? raw.maxCalls;
  if (maxToolCalls === undefined) {
    throw new Error('internal: maxToolCalls missing after schema refine');
  }
  const expectedHash = hexToBuffer32(raw.secretHash);
  if (expectedHash.length !== 32) {
    throw new Error(`invalid secretHash length for id ${raw.id}`);
  }
  let windowMs: number;
  try {
    windowMs = parseQuotaWindowMs(raw.window);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`id ${raw.id}: ${msg}`);
  }
  return {
    id: raw.id,
    maxToolCalls,
    windowMs,
    label: raw.label,
    expectedHash,
    prefix: raw.prefix ?? null,
  };
}

function verifyEntry(entry: InternalEntry, presentedKey: string, pepper: string): boolean {
  let material: string;
  if (entry.prefix === null) {
    material = presentedKey;
  } else {
    if (!presentedKey.startsWith(entry.prefix)) {
      return false;
    }
    material = presentedKey.slice(entry.prefix.length);
    if (material.length === 0) {
      return false;
    }
  }

  const digest = digestSecretForLookup(pepper, material);
  if (digest.length !== entry.expectedHash.length) {
    return false;
  }
  return timingSafeEqual(digest, entry.expectedHash);
}

export type ApiKeyRegistry = {
  /** Number of configured keys */
  readonly size: number;
  /**
   * Looks up a presented client API key. Returns null if the key is missing, empty, or not registered.
   * Uses SHA-256(`${pepper}:${material}`) and timing-safe equality on the digest.
   */
  lookup: (presentedKey: string | undefined | null) => ApiKeyRegistryEntry | null;
};

function createRegistry(internal: InternalEntry[], pepper: string): ApiKeyRegistry {
  return {
    get size() {
      return internal.length;
    },
    lookup(presentedKey: string | undefined | null): ApiKeyRegistryEntry | null {
      if (presentedKey === undefined || presentedKey === null) {
        return null;
      }
      const trimmed = presentedKey.trim();
      if (trimmed.length === 0) {
        return null;
      }

      for (const entry of internal) {
        if (verifyEntry(entry, trimmed, pepper)) {
          const { expectedHash: _h, prefix: _p, ...publicEntry } = entry;
          return publicEntry;
        }
      }
      return null;
    },
  };
}

function parseRawRegistryList(jsonText: string): z.infer<typeof RawRegistrySchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (e) {
    throw new Error(
      `MCP client API keys JSON: invalid JSON (${e instanceof Error ? e.message : String(e)})`
    );
  }
  return RawRegistrySchema.parse(parsed);
}

/**
 * Builds the map-based registry used by MCP quota (hash lookup, no per-request iteration).
 */
export function buildClientApiKeyRegistryFromJson(
  jsonText: string,
  _pepper: string
): ClientApiKeyRegistry {
  const rawList = parseRawRegistryList(jsonText);
  const ids = new Set<string>();
  const byHash = new Map<string, ApiKeyRegistryEntry>();
  const entries: ApiKeyRegistryEntry[] = [];

  for (const raw of rawList) {
    if (ids.has(raw.id)) {
      throw new Error(`duplicate API key registry id: ${raw.id}`);
    }
    ids.add(raw.id);
    const internal = buildInternalEntry(raw);
    const hex = internal.expectedHash.toString('hex');
    if (byHash.has(hex)) {
      throw new Error(`duplicate API key hash in registry (id ${raw.id})`);
    }
    const pub: ApiKeyRegistryEntry = {
      id: internal.id,
      maxToolCalls: internal.maxToolCalls,
      windowMs: internal.windowMs,
      ...(internal.label !== undefined ? { label: internal.label } : {}),
    };
    byHash.set(hex, pub);
    entries.push(pub);
  }

  return { entries, byHash };
}

/**
 * Parses and validates registry JSON. Throws on invalid shape, duplicate ids, or invalid windows.
 */
export function parseApiKeyRegistryJson(jsonText: string, pepper: string): ApiKeyRegistry {
  const rawList = parseRawRegistryList(jsonText);
  const ids = new Set<string>();
  const internal: InternalEntry[] = [];
  for (const raw of rawList) {
    if (ids.has(raw.id)) {
      throw new Error(`duplicate API key registry id: ${raw.id}`);
    }
    ids.add(raw.id);
    internal.push(buildInternalEntry(raw));
  }
  return createRegistry(internal, pepper);
}

/**
 * Loads registry from a UTF-8 file (same JSON as {@link parseApiKeyRegistryJson}).
 */
export function loadApiKeyRegistryFromFile(filePath: string, pepper: string): ApiKeyRegistry {
  const jsonText = readFileSync(filePath, 'utf8');
  return parseApiKeyRegistryJson(jsonText, pepper);
}

export type LoadApiKeyRegistryFromEnvOptions = {
  env?: NodeJS.ProcessEnv;
};

/**
 * Loads the registry from {@link MCP_CLIENT_API_KEYS_FILE_ENV} if set, otherwise {@link MCP_CLIENT_API_KEYS_JSON_ENV}.
 * If neither is set or both are empty, returns an empty registry (size 0).
 */
export function loadApiKeyRegistryFromProcessEnv(
  options?: LoadApiKeyRegistryFromEnvOptions
): ApiKeyRegistry {
  const env = options?.env ?? process.env;
  const pepper = env[MCP_CLIENT_API_KEY_PEPPER_ENV] ?? '';
  const filePath = env[MCP_CLIENT_API_KEYS_FILE_ENV]?.trim();
  const jsonInline = env[MCP_CLIENT_API_KEYS_JSON_ENV]?.trim();

  let jsonText: string | undefined;
  if (filePath) {
    jsonText = readFileSync(filePath, 'utf8');
  } else if (jsonInline) {
    jsonText = jsonInline;
  }

  if (jsonText === undefined || jsonText.trim() === '') {
    return createRegistry([], pepper);
  }
  return parseApiKeyRegistryJson(jsonText, pepper);
}
