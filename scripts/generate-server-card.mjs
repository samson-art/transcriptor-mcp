/**
 * Writes `.well-known/mcp/server-card.json` for Smithery / SEP-1649 discovery without MCP init.
 * Run after build: `npm run build && npm run generate:server-card`
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMcpServer } from '../dist/mcp-core.js';
import {
  normalizeObjectSchema,
  getObjectShape,
  getSchemaDescription,
  isSchemaOptional,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object', properties: {} };

function promptArgumentsFromSchema(schema) {
  const shape = getObjectShape(schema);
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => ({
    name,
    description: getSchemaDescription(field),
    required: !isSchemaOptional(field),
  }));
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const mcp = createMcpServer();
const registeredTools = mcp._registeredTools;

const tools = Object.entries(registeredTools)
  .filter(([, t]) => t.enabled)
  .map(([name, tool]) => {
    const row = {
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: (() => {
        const obj = normalizeObjectSchema(tool.inputSchema);
        return obj
          ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
          : EMPTY_OBJECT_JSON_SCHEMA;
      })(),
    };
    if (tool.annotations && Object.keys(tool.annotations).length > 0) {
      row.annotations = tool.annotations;
    }
    return row;
  });

const prompts = Object.entries(mcp._registeredPrompts)
  .filter(([, p]) => p.enabled)
  .map(([name, prompt]) => {
    const row = {
      name,
      title: prompt.title,
      description: prompt.description,
    };
    if (prompt.argsSchema) {
      row.arguments = promptArgumentsFromSchema(prompt.argsSchema);
    }
    return row;
  });

const card = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
  version: '1.0',
  protocolVersion: '2024-11-05',
  serverInfo: {
    name: 'transcriptor-mcp',
    title: 'Transcriptor MCP',
    version: pkg.version,
  },
  description:
    'Download subtitles and transcripts (YouTube and other platforms), video metadata, chapters, playlists, and search via MCP.',
  documentationUrl: 'https://github.com/samson-art/transcriptor-mcp#readme',
  transport: {
    type: 'streamable-http',
    endpoint: '/mcp',
  },
  capabilities: {
    tools: { listChanged: true },
    prompts: { listChanged: true },
    resources: { listChanged: true, subscribe: false },
  },
  // Do not advertise schemes like "bearer" / "oauth2" here: Smithery (and other
  // clients) then probe /.well-known/oauth-protected-resource and OIDC metadata.
  // This deployment uses edge header X-MCP-Api-Token (Smithery session apiToken),
  // not RFC 9728 OAuth on the origin — false OAuth hints caused 404 + UI auth errors.
  authentication: {
    required: false,
  },
  instructions:
    'Smithery: paste your Google-Form-issued token into apiToken in session config; the gateway sends X-MCP-Api-Token to your edge (APISIX key-auth).',
  tools,
  prompts,
  resources: [],
};

const outDir = join(root, '.well-known', 'mcp');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'server-card.json');
writeFileSync(outPath, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
console.log('Wrote', outPath);
