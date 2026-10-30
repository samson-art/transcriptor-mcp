// ext-apps ships ESM only, which ts-jest cannot load. Shim it onto the real McpServer
// registration methods, as src/mcp-http.test.ts does. The real registerAppTool also adds a
// `ui/resourceUri` key to `_meta`, so the fixture does not have that key.
jest.mock('@modelcontextprotocol/ext-apps/server', () => ({
  registerAppTool: (
    server: { registerTool: (name: string, def: unknown, handler: unknown) => unknown },
    name: string,
    def: unknown,
    handler: unknown
  ) => server.registerTool(name, def, handler),
  registerAppResource: (
    server: {
      registerResource: (name: string, uri: string, def: unknown, handler: unknown) => unknown;
    },
    name: string,
    uri: string,
    def: unknown,
    handler: unknown
  ) => server.registerResource(name, uri, def, handler),
  RESOURCE_MIME_TYPE: 'text/html;profile=mcp-app',
}));

import { readFileSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { createMcpServer } from './mcp-core.js';

const DRAFT_2020_12_SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema';

type ToolsList = { tools: Array<{ inputSchema: AnySchemaObject; outputSchema: AnySchemaObject }> };

/**
 * The tools/list result as the wire carries it. This sends raw JSON-RPC and does not use the
 * SDK client, because the client drops keys that its own schema does not know.
 */
async function listTools(): Promise<ToolsList> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
  await createMcpServer({ logger }).connect(serverSide);
  const reply = new Promise<JSONRPCMessage>((resolve) => {
    client.onmessage = (message) => {
      if ('id' in message && message.id === 1) resolve(message);
    };
  });
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return (JSON.parse(JSON.stringify(await reply)) as { result: ToolsList }).result;
}

describe('tools/list through the real SDK', () => {
  // Clients can store the tool schemas, and OpenAI can hold the published ChatGPT app for
  // review when they change (#80). So each change to this list must change the fixture too.
  it('lists the 8 tools exactly as the saved fixture pins them', async () => {
    const fixture: unknown = JSON.parse(readFileSync('src/mcp-tools-list.fixture.json', 'utf-8'));

    expect(await listTools()).toEqual(fixture);
  });

  it('labels all 16 input and output schemas JSON Schema 2020-12, and each compiles in a 2020-12 validator', async () => {
    const schemas = (await listTools()).tools.flatMap((tool) => [
      tool.inputSchema,
      tool.outputSchema,
    ]);

    expect(schemas.map((schema) => schema?.$schema)).toEqual(
      Array(16).fill(DRAFT_2020_12_SCHEMA_URI)
    );
    // One instance: the schemas have no $id, so they cannot clash. allowUnionTypes accepts
    // the nullable fields, such as `type: ["string", "null"]`.
    const ajv = new Ajv2020({ allowUnionTypes: true });
    for (const schema of schemas) {
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });
});
