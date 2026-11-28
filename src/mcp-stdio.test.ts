// ext-apps ships ESM only, which ts-jest cannot load. Shim it onto the real McpServer
// registration methods, as in mcp-http.test.ts, so the tool surface stays intact.
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
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { NotFoundError } from './errors.js';
import { createMcpServer } from './mcp-core.js';
import * as validation from './validation.js';

type Answer = {
  id?: number;
  result?: { [key: string]: any };
  error?: { code?: number; message?: string; data?: unknown };
};

/** What `npm run start:mcp` serves (src/mcp.ts), on in-memory streams instead of the process. */
async function stdioSession() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = createMcpServer({ logger: pino({ level: 'silent' }) as FastifyBaseLogger });
  await server.connect(new StdioServerTransport(stdin, stdout));

  const waiting = new Map<number, { resolve: (a: Answer) => void; reject: (e: Error) => void }>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let answer: Answer;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        // stdout carries only JSON-RPC: any other line fails every request that waits.
        for (const { reject } of waiting.values()) {
          reject(new Error(`stdout line that is not JSON-RPC: ${line}`));
        }
        continue;
      }
      if (answer.id !== undefined) waiting.get(answer.id)?.resolve(answer);
    }
  });

  let lastId = 0;
  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<Answer>((resolve, reject) => {
      const id = ++lastId;
      waiting.set(id, { resolve, reject });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) })}\n`);
    });
  const notify = (method: string) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, notify, close: () => server.close() };
}

describe('MCP over stdio', () => {
  let session: Awaited<ReturnType<typeof stdioSession>>;
  let initialize: Answer;

  beforeAll(async () => {
    session = await stdioSession();
    initialize = await session.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mcp-stdio-test', version: '1.0.0' },
    });
    session.notify('notifications/initialized');
  });

  afterAll(async () => {
    await session.close();
  });

  it('answers initialize with the 2025 protocol and the capabilities of #84', () => {
    expect(initialize.result?.protocolVersion).toBe('2025-11-25');
    expect(initialize.result?.serverInfo?.name).toBe('transcriptor-mcp');
    expect(initialize.result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
      extensions: { 'io.modelcontextprotocol/ui': {} },
    });
  });

  it('answers a transcript read for a missing video with -32602 and the text of the cause', async () => {
    const read = jest
      .spyOn(validation, 'validateAndDownloadSubtitles')
      .mockRejectedValue(new NotFoundError('No subtitles.'));
    const answer = await session.request('resources/read', {
      uri: 'transcriptor://transcript/abc',
    });
    read.mockRestore();

    expect(answer.error).toEqual({
      code: -32602,
      message: 'No subtitles.',
      data: { uri: 'transcriptor://transcript/abc' },
    });
  });

  it('lists the same tools as over HTTP, as stored in src/mcp-tools-contract.json', async () => {
    const answer = await session.request('tools/list');
    const file = join(process.cwd(), 'src', 'mcp-tools-contract.json');

    expect(answer.result?.tools).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  // Over stdio, the server serves only the 2025 protocol until #86. There server/discover is
  // not a method, so a client that probes with it falls back to initialize.
  it('answers server/discover with method not found', async () => {
    const answer = await session.request('server/discover', {});

    expect(answer.error?.code).toBe(-32601);
  });
});
