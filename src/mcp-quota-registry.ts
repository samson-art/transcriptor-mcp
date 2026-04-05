import { readFileSync } from 'node:fs';

import {
  buildClientApiKeyRegistryFromJson,
  type ClientApiKeyRegistry,
} from './api-key-registry.js';

export type { ClientApiKeyRegistry };

/** Alias for {@link import('./api-key-registry.js').ApiKeyRegistryEntry} */
export type ClientApiKeyRecord = import('./api-key-registry.js').ApiKeyRegistryEntry;

export { hashPresentedApiKey as hashClientApiKey } from './api-key-registry.js';

/**
 * Loads client API keys from {@link import('./api-key-registry.js').MCP_CLIENT_API_KEYS_FILE_ENV}
 * or {@link import('./api-key-registry.js').MCP_CLIENT_API_KEYS_JSON_ENV}.
 * Registry entries use `secretHash` (hex of sha256(pepper:keyMaterial)); lookup uses `hashPresentedApiKey`.
 */
export function loadClientApiKeysFromEnv(pepper: string): ClientApiKeyRegistry {
  const filePath = process.env.MCP_CLIENT_API_KEYS_FILE?.trim();
  const jsonEnv = process.env.MCP_CLIENT_API_KEYS_JSON?.trim();

  let text: string | undefined;
  if (filePath) {
    text = readFileSync(filePath, 'utf8');
  } else if (jsonEnv) {
    text = jsonEnv;
  } else {
    return { entries: [], byHash: new Map() };
  }

  return buildClientApiKeyRegistryFromJson(text, pepper);
}
