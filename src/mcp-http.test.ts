import type { FastifyInstance } from 'fastify';

// ext-apps ships ESM only, which ts-jest cannot load. Shim it onto the real McpServer
// registration methods so the tool and resource surface stays intact.
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

import { buildMcpHttpApp } from './mcp-http.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

let app: FastifyInstance;
let baseUrl: string;

type JsonRpcBody = {
  jsonrpc?: string;
  result?: { [key: string]: any };
  error?: { code?: number; message?: string };
};

/** The SDK may answer a POST with plain JSON or with a single SSE frame; accept both. */
async function readMcpBody(response: Response): Promise<JsonRpcBody> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      throw new Error(`No data frame in SSE response: ${text}`);
    }
    return JSON.parse(dataLine.slice('data:'.length).trim()) as JsonRpcBody;
  }
  return JSON.parse(text) as JsonRpcBody;
}

function postMcp(body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-http-test', version: '1.0.0' },
    },
  };
}

beforeAll(async () => {
  app = buildMcpHttpApp({ loggerInstance: createLoggerWithSentryBreadcrumbs({ level: 'silent' }) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to listen on a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('POST /mcp', () => {
  it('answers initialize without issuing a session id', async () => {
    const response = await postMcp(initializeBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();

    const body = await readMcpBody(response);
    expect(body.result?.serverInfo?.name).toBe('transcriptor-mcp');
    expect(typeof body.result?.protocolVersion).toBe('string');
  });

  it('serves tools/list on its own request, with no prior initialize', async () => {
    const response = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(response.status).toBe(200);
    const body = await readMcpBody(response);
    const toolNames = (body.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'get_transcript',
        'get_raw_subtitles',
        'get_available_subtitles',
        'get_video_info',
        'get_video_chapters',
        'get_video_frame',
        'get_playlist_transcripts',
        'search_videos',
      ])
    );
  });

  it('handles consecutive requests, each with a fresh transport', async () => {
    // A hoisted/reused stateless transport makes the SDK throw on the second request.
    const first = await postMcp(initializeBody(10));
    const second = await postMcp(initializeBody(11));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await readMcpBody(second)).result?.serverInfo?.name).toBe('transcriptor-mcp');
  });

  it('does not require an Authorization header (auth belongs to the gateway)', async () => {
    const response = await postMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects an Accept header without text/event-stream', async () => {
    const response = await postMcp(initializeBody(), { accept: 'application/json' });

    expect(response.status).toBe(406);
  });

  it('rejects a non-JSON content type', async () => {
    const response = await postMcp('not json', { 'content-type': 'text/plain' });

    expect(response.status).toBe(415);
    const body = await readMcpBody(response);
    expect(body.jsonrpc).toBe('2.0');
    expect(typeof body.error?.code).toBe('number');
  });

  it('returns a JSON-RPC parse error for a malformed body', async () => {
    const response = await postMcp('{ not json');

    expect(response.status).toBe(400);
    const body = await readMcpBody(response);
    expect(body.error?.code).toBe(-32700);
  });
});

describe('GET and DELETE /mcp', () => {
  it('answers GET with 405 instead of opening a stream', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    const body = await readMcpBody(response);
    expect(body.error?.message).toBe('Method not allowed.');
  });

  it('answers DELETE with 405', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });

    expect(response.status).toBe(405);
  });
});

describe('operational endpoints', () => {
  it('serves GET /health', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('serves Prometheus metrics, including the mcp_ series', async () => {
    const response = await fetch(`${baseUrl}/metrics`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('mcp_tool_calls_total');
  });

  it('returns a JSON-RPC method-not-found for the retired /sse path', async () => {
    const response = await fetch(`${baseUrl}/sse`);

    expect(response.status).toBe(404);
    const body = await readMcpBody(response);
    expect(body.error?.code).toBe(-32601);
  });
});
