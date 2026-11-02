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

import { readFileSync, writeFileSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { createMcpServer } from './mcp-core.js';

const FIXTURE_PATH = 'src/mcp-tools-list.fixture.json';

type ToolsList = { tools: Array<{ inputSchema: AnySchemaObject; outputSchema: AnySchemaObject }> };

/**
 * The tools/list result as the wire carries it. This sends raw JSON-RPC and does not use the
 * SDK client, because the client drops keys that its own schema does not know.
 */
async function listTools(): Promise<ToolsList> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const reply = new Promise<JSONRPCMessage>((resolve) => {
    client.onmessage = (message) => {
      if ('id' in message && message.id === 1) resolve(message);
    };
  });
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return (JSON.parse(JSON.stringify(await reply)) as { result: ToolsList }).result;
}

describe('tools/list through the real SDK', () => {
  let listing: ToolsList;

  beforeAll(async () => {
    listing = await listTools();
  });

  // Clients can store the tool schemas, and OpenAI can hold the published ChatGPT app for
  // review when they change (#80). So each change to this list must change the fixture too.
  // After a deliberate change, rewrite the fixture and read its diff:
  //   UPDATE_TOOLS_FIXTURE=1 npx jest src/mcp-tools-list.test.ts
  // The rewrite never adds the `ui/resourceUri` keys, because the shim above does not add them.
  it('lists the 8 tools exactly as the saved fixture pins them', () => {
    if (process.env.UPDATE_TOOLS_FIXTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(listing, null, 2)}\n`);
    }
    const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

    expect(listing).toEqual(fixture);
  });

  it('compiles all input and output schemas in a 2020-12 validator', () => {
    // One instance: the schemas have no $id, so they cannot clash.
    const ajv = new Ajv2020();
    for (const tool of listing.tools) {
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema)).not.toThrow();
    }
  });
});
