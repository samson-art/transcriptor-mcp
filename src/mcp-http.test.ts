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

// Tool calls must not start the real yt-dlp; each test answers for it.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFile: jest.fn(),
}));

// Only to see what reaches Sentry; nothing initialises Sentry here, so nothing is sent.
jest.mock('@sentry/node', () => ({
  ...jest.requireActual<typeof import('@sentry/node')>('@sentry/node'),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureEvent: jest.fn(),
}));

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import {
  INVALID_VIDEO_URL_MESSAGE,
  ORIGIN_NOT_ALLOWED_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  YtDlpError,
} from './errors.js';
import * as mcpCore from './mcp-core.js';
import { buildMcpHttpApp } from './mcp-http.js';
import * as whisperJobs from './whisper-jobs.js';

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

const MODERN = '2026-07-28';

/** A 2026-07-28 request: the version and the client capabilities ride in `_meta`. */
function modernBody(id: number, method: string, params: Record<string, unknown> = {}) {
  const body: {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params: Record<string, unknown> & { _meta: Record<string, unknown> };
  } = {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'mcp-http-test', version: '1.0.0' },
        ...(params._meta as Record<string, unknown> | undefined),
      },
    },
  };
  return body;
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    'mcp-protocol-version': MODERN,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  };
}

beforeAll(async () => {
  // A route with logLevel 'warn' logs even under a silent logger, so send the lines nowhere (#138).
  app = buildMcpHttpApp({
    loggerInstance: pino({ level: 'silent' }, { write: () => {} }) as FastifyBaseLogger,
  });
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

// A fresh app whose warn and error lines land in `lines`, as pino writes them.
function appWithLogLines() {
  const lines: Array<Record<string, unknown>> = [];
  const local = buildMcpHttpApp({
    loggerInstance: pino(
      { level: 'warn' },
      { write: (line: string) => lines.push(JSON.parse(line)) }
    ) as FastifyBaseLogger,
  });
  return { local, lines };
}

describe('POST /mcp', () => {
  it('answers initialize without issuing a session id', async () => {
    const response = await postMcp(initializeBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();

    const body = await readMcpBody(response);
    expect(body.result?.serverInfo?.name).toBe('transcriptor-mcp');
    expect(typeof body.result?.protocolVersion).toBe('string');
    // The lists never change, and the 4 widgets are MCP Apps (#84).
    expect(body.result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
      extensions: { 'io.modelcontextprotocol/ui': {} },
    });
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

  // The tools/list answer is the contract that clients read (#80: one schema label made
  // some Claude apps refuse every call). A planned change shows as a diff of the JSON file.
  // To accept a change: UPDATE_TOOLS_CONTRACT=1 npx jest src/mcp-http.test.ts -t 'tool contract'
  // ponytail: the ext-apps mock above passes _meta through as written, so keys that the
  // real registerAppTool adds are not in the file. Pin those when ts-jest can load ESM.
  it('keeps the tool contract equal to src/mcp-tools-contract.json', async () => {
    const response = await postMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(response.status).toBe(200);
    const body = await readMcpBody(response);
    const actual = body.result?.tools;
    // A failed answer must not overwrite the stored file in update mode.
    expect(Array.isArray(actual)).toBe(true);
    const file = join(process.cwd(), 'src', 'mcp-tools-contract.json');

    if (process.env.UPDATE_TOOLS_CONTRACT === '1') {
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  // Some Claude apps refuse a tool whose schema has the draft-07 label (#80). Ajv2020 throws on
  // that label, so this fails if tools/list goes back to draft-07. Since SDK 2.x (#83), the SDK
  // itself writes the 2020-12 label.
  it('lists schemas that a JSON Schema 2020-12 validator compiles', async () => {
    const body = await readMcpBody(await postMcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
    const tools: Array<{ inputSchema: AnySchemaObject; outputSchema: AnySchemaObject }> =
      body.result?.tools ?? [];
    expect(tools).toHaveLength(8);
    const ajv = new Ajv2020();
    for (const tool of tools) {
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema)).not.toThrow();
    }
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

  // GHSA-f897-62hf-6gxq (#130): before SDK 1.30.1, one long batch was able to block the server
  // for every caller. Fastify parses the body here, so this test makes sure that the SDK counts.
  it('refuses a JSON-RPC batch of more than 100 messages', async () => {
    const batch = Array.from({ length: 101 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/list',
    }));
    const response = await postMcp(batch);
    // Read first: an unread stream of answers keeps the server from closing.
    const body = await readMcpBody(response);

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe(-32600);
  });

  it('answers initialize with 2025-06-18 in 2025-06-18', async () => {
    const body = await readMcpBody(await postMcp(initializeBody()));

    expect(body.result?.protocolVersion).toBe('2025-06-18');
  });
});

function toolCallBody(
  id: number,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>
) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  };
}

describe('tools/call', () => {
  // Strict input objects would refuse the key with an input error. Since 1.5.21 at least,
  // the server drops it and runs the tool, here up to its own check of the link.
  it('drops an unknown argument key and answers as without it', async () => {
    const url = 'not a video link';
    const without = await readMcpBody(await postMcp(toolCallBody(30, 'get_transcript', { url })));
    const withKey = await readMcpBody(
      await postMcp(toolCallBody(31, 'get_transcript', { url, extra_key: 1 }))
    );

    expect(without.result?.content?.[0]?.text).toBe(INVALID_VIDEO_URL_MESSAGE);
    expect(withKey.result).toEqual(without.result);
  });

  // The widgets mark their own calls in _meta (#115). The SDK hands the _meta of the request to
  // the tool, and the "MCP tool call" line and mcp_tool_calls_total take `source` from it.
  it('logs source widget for a call whose _meta says so, and source model otherwise', async () => {
    const { local, lines } = appWithLogLines();
    await local.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(local.server.address() as AddressInfo).port}/mcp`;
    const call = async (id: number, meta?: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
        body: JSON.stringify(toolCallBody(id, 'get_video_info', { url: 'not a video link' }, meta)),
      });
      // The failed call logs at warn, so the warn logger of the app sees the line.
      return response.text();
    };

    try {
      await call(32, { 'transcriptor/source': 'widget' });
      await call(33);
    } finally {
      await local.close();
    }

    const toolLines = lines.filter((line) => line.msg === 'MCP tool call');
    expect(toolLines.map((line) => [line.tool, line.source])).toEqual([
      ['get_video_info', 'widget'],
      ['get_video_info', 'model'],
    ]);
  });

  it("hands a listed track name like Facebook's en_US to yt-dlp unchanged", async () => {
    const execFileMock = execFile as unknown as jest.Mock;
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (e: null, r: object) => void) =>
        callback(null, { stdout: '', stderr: '' })
    );

    const response = await postMcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'get_raw_subtitles',
        arguments: { url: 'https://www.facebook.com/watch?v=1', type: 'official', lang: 'en_US' },
      },
    });

    expect(response.status).toBe(200);
    const subArgs = execFileMock.mock.calls
      .map((call) => call[1] as string[])
      .find((args) => args.includes('--sub-lang'));
    expect(subArgs?.[subArgs.indexOf('--sub-lang') + 1]).toBe('en_US');
  });

  it('does not start speech-to-text for get_transcript without lang when YT_DLP_NO_WARNINGS=1 hides a bot check', async () => {
    process.env.YT_DLP_NO_WARNINGS = '1';
    process.env.WHISPER_MODE = 'local';
    const whisperSpy = jest
      .spyOn(whisperJobs, 'startOrReuseWhisperJob')
      .mockResolvedValue(null as never);
    const execFileMock = execFile as unknown as jest.Mock;
    execFileMock.mockReset();
    // Like yt-dlp with --ignore-no-formats-error: exit 0, a stub without formats, and the
    // refusal only in a WARNING line, which --no-warnings drops.
    execFileMock.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: (e: null, r: object) => void) =>
        callback(null, {
          stdout: JSON.stringify({ id: 'x', title: 'youtube video #x', formats: [] }),
          stderr: args.includes('--no-warnings')
            ? ''
            : "WARNING: [youtube] x: Sign in to confirm you're not a bot\nWARNING: No video formats found!",
        })
    );

    try {
      const response = await postMcp({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_transcript',
          arguments: { url: 'https://www.youtube.com/watch?v=noWarnBot01' },
        },
      });

      const body = await readMcpBody(response);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toBe(new YtDlpError('bot_check').message);
      expect(whisperSpy).not.toHaveBeenCalled();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.YT_DLP_NO_WARNINGS;
      delete process.env.WHISPER_MODE;
      whisperSpy.mockRestore();
    }
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

describe('unplanned errors', () => {
  const PATH_ERROR = "ENOENT: no such file or directory, open '/app/CHANGELOG.md'";

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('answers a 5xx from the error handler with the generic text, not its message', async () => {
    const { local, lines } = appWithLogLines();
    local.get('/boom', () => {
      throw new Error(PATH_ERROR);
    });

    const response = await local.inject({ method: 'GET', url: '/boom' });
    await local.close();

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    // The operator still gets the real error, in the log and in Sentry.
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, err: expect.objectContaining({ message: PATH_ERROR }) })
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: PATH_ERROR })
    );
  });

  // Before #85 the answer had `id: null`. The SDK handler knows the id, so the client can match it.
  it.each([
    ['2025', initializeBody(7), {}],
    ['2026-07-28', modernBody(7, 'tools/list'), modernHeaders('tools/list')],
  ])(
    'answers a failed server build in the %s era with the generic text and the request id',
    async (_era, payload, headers) => {
      jest.spyOn(mcpCore, 'createMcpServer').mockImplementation(() => {
        throw new Error(PATH_ERROR);
      });
      const { local, lines } = appWithLogLines();

      const response = await local.inject({
        method: 'POST',
        url: '/mcp',
        payload,
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, ...headers },
      });
      await local.close();

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: UNEXPECTED_ERROR_MESSAGE },
        id: 7,
      });
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 50,
          err: expect.objectContaining({ message: PATH_ERROR }),
        })
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: PATH_ERROR })
      );
    }
  );
});

describe('Origin rule (#82)', () => {
  beforeEach(() => {
    delete process.env.MCP_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    delete process.env.MCP_ALLOWED_ORIGINS;
  });

  // An allowed Origin must get exactly the answer that a request without Origin gets.
  async function toolsListAnswer(headers?: Record<string, string>) {
    const response = await postMcp({ jsonrpc: '2.0', id: 20, method: 'tools/list' }, headers);
    return { status: response.status, body: await readMcpBody(response) };
  }

  it('refuses a tools/call with a foreign Origin: 403, a JSON-RPC error, and no tool runs', async () => {
    const execFileMock = execFile as unknown as jest.Mock;
    execFileMock.mockReset();
    // Before the fix the tool ran. If this stub does not answer, that call hangs.
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (e: null, r: object) => void) =>
        callback(null, { stdout: '', stderr: '' })
    );
    const createMcpServer = jest.spyOn(mcpCore, 'createMcpServer');

    try {
      const response = await postMcp(
        {
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'get_raw_subtitles',
            arguments: {
              url: 'https://www.facebook.com/watch?v=1',
              type: 'official',
              lang: 'en_US',
            },
          },
        },
        { origin: 'https://example.com' }
      );

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: ORIGIN_NOT_ALLOWED_MESSAGE },
        id: null,
      });
      expect(text).not.toContain('example.com');
      expect(createMcpServer).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      createMcpServer.mockRestore();
    }
  });

  // `null` is what a page with a no-referrer policy sends. The other two have the word
  // localhost in them, but no loopback hostname over http or https.
  it.each(['null', 'http://localhost.example.com', 'ws://localhost:6274'])(
    'refuses Origin %s with 403 by default',
    async (origin) => {
      expect((await toolsListAnswer({ origin })).status).toBe(403);
    }
  );

  it.each(['GET', 'DELETE'])(
    'answers %s with a refused Origin with 403, not 405',
    async (method) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: { origin: 'https://example.com' },
      });

      expect(response.status).toBe(403);
      expect((await readMcpBody(response)).error).toEqual({
        code: -32000,
        message: ORIGIN_NOT_ALLOWED_MESSAGE,
      });
    }
  );

  // A browser never sends an empty Origin, so an empty value counts as no Origin.
  it.each(['http://localhost:6274', 'https://127.0.0.1:4200', 'http://[::1]:8080', ''])(
    'by default answers Origin %p as it answers no Origin',
    async (origin) => {
      expect(await toolsListAnswer({ origin })).toEqual(await toolsListAnswer());
    }
  );

  it('with MCP_ALLOWED_ORIGINS set, allows exactly the listed origins and no longer the loopback ones', async () => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://app.example.com, https://admin.example.com';
    const noOrigin = await toolsListAnswer();

    expect(await toolsListAnswer({ origin: 'https://app.example.com' })).toEqual(noOrigin);
    expect(await toolsListAnswer({ origin: 'https://admin.example.com' })).toEqual(noOrigin);
    expect((await toolsListAnswer({ origin: 'https://app.example.com.evil.example' })).status).toBe(
      403
    );
    expect((await toolsListAnswer({ origin: 'http://localhost:6274' })).status).toBe(403);
  });

  it('treats a MCP_ALLOWED_ORIGINS with no origin in it as not set', async () => {
    process.env.MCP_ALLOWED_ORIGINS = ' , ';

    expect(await toolsListAnswer({ origin: 'http://localhost:6274' })).toEqual(
      await toolsListAnswer()
    );
    expect((await toolsListAnswer({ origin: 'https://example.com' })).status).toBe(403);
  });

  it('with MCP_ALLOWED_ORIGINS=*, answers any Origin as it answers no Origin', async () => {
    process.env.MCP_ALLOWED_ORIGINS = '*';

    expect(await toolsListAnswer({ origin: 'https://example.com' })).toEqual(
      await toolsListAnswer()
    );
  });

  it.each(['/health', '/metrics'])('serves %s whatever the Origin', async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { origin: 'https://example.com' },
    });

    expect(response.status).toBe(200);
  });

  it('writes one warn line with the hostname of the Origin, and sends nothing to Sentry', async () => {
    const captureException = Sentry.captureException as unknown as jest.Mock;
    const captureMessage = Sentry.captureMessage as unknown as jest.Mock;
    const captureEvent = Sentry.captureEvent as unknown as jest.Mock;
    [captureException, captureMessage, captureEvent].forEach((mock) => mock.mockClear());
    // The exports above only wrap the scope, so a hook could also report through a scope.
    const scopeCaptures = (['captureException', 'captureMessage', 'captureEvent'] as const).map(
      (method) => jest.spyOn(Sentry.Scope.prototype, method)
    );
    const { local, lines } = appWithLogLines();

    try {
      const response = await local.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 22, method: 'tools/list' },
        headers: {
          'content-type': 'application/json',
          accept: MCP_ACCEPT,
          origin: 'https://rebind.example:8443',
        },
      });
      await local.close();

      expect(response.statusCode).toBe(403);
      expect(lines).toEqual([expect.objectContaining({ level: 40, originHost: 'rebind.example' })]);
      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureEvent).not.toHaveBeenCalled();
      scopeCaptures.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } finally {
      scopeCaptures.forEach((spy) => spy.mockRestore());
    }
  });

  it.each([
    'https://app.example.com/',
    'https://app.example.com:443',
    'https://App.Example.com',
    '"https://other.example",https://app.example.com/',
  ])('matches the listed entry %s against the origin that a browser sends', async (entry) => {
    process.env.MCP_ALLOWED_ORIGINS = entry;

    expect(await toolsListAnswer({ origin: 'https://app.example.com' })).toEqual(
      await toolsListAnswer()
    );
    expect((await toolsListAnswer({ origin: 'https://app.example.com:8443' })).status).toBe(403);
    expect((await toolsListAnswer({ origin: 'http://app.example.com' })).status).toBe(403);
  });

  it('normalizes the Origin header before it compares', async () => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://app.example.com';

    expect(await toolsListAnswer({ origin: 'https://APP.example.com' })).toEqual(
      await toolsListAnswer()
    );
  });

  // `file:///x` has the origin `null` once parsed, and that must not match a file page either.
  it.each(['null', 'file:///x'])(
    'does not let an Origin of null pass when the list has the entry %s',
    async (entry) => {
      process.env.MCP_ALLOWED_ORIGINS = `${entry},https://app.example.com`;

      expect((await toolsListAnswer({ origin: 'null' })).status).toBe(403);
      expect((await toolsListAnswer({ origin: 'file:///y' })).status).toBe(403);
      expect(await toolsListAnswer({ origin: 'https://app.example.com' })).toEqual(
        await toolsListAnswer()
      );
    }
  );

  it.each([
    '"https://app.example.com"',
    "'https://app.example.com'",
    'https://app.example.com"',
    '"https://app.example.com,https://app.example.com"',
    '"*"',
    'null',
    'app.example.com',
    'localhost:3000',
    'ws://app.example.com',
    'https://*.example.com',
    'https://app.example.com/admin',
    'https://app.example.com/?x=1',
  ])('refuses every Origin when the list has only the bad value %s', async (value) => {
    process.env.MCP_ALLOWED_ORIGINS = value;
    const { local, lines } = appWithLogLines();
    await local.close();

    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line) => expect(line.msg).toContain('refuses every Origin'));
    expect((await toolsListAnswer({ origin: 'https://app.example.com' })).status).toBe(403);
    expect((await toolsListAnswer({ origin: 'http://localhost:6274' })).status).toBe(403);
    expect((await toolsListAnswer()).status).toBe(200);
  });

  describe('warn lines at the start of the server', () => {
    function startLines(value: string) {
      process.env.MCP_ALLOWED_ORIGINS = value;
      const { local, lines } = appWithLogLines();
      void local.close();
      return lines;
    }

    it('writes one line for each dropped entry, with its position and not its value', () => {
      const lines = startLines('null, https://app.example.com, s3cret-token');

      expect(lines).toEqual([
        expect.objectContaining({ level: 40, entryPosition: 1 }),
        expect.objectContaining({ level: 40, entryPosition: 3 }),
      ]);
      expect(JSON.stringify(lines)).not.toContain('s3cret-token');
      expect(JSON.stringify(lines)).not.toContain('every Origin');
    });

    it.each(['"https://app.example.com"', '"*"', 'null,"*"'])(
      'says that the server refuses every Origin when only dropped entries are left: %s',
      (value) => {
        const lines = startLines(value);

        expect(lines.length).toBeGreaterThan(0);
        lines.forEach((line) => expect(line.msg).toContain('refuses every Origin'));
      }
    );

    it.each(['', ' , ', '*', 'https://app.example.com', 'https://app.example.com/'])(
      'writes no line for %p',
      (value) => {
        expect(startLines(value)).toEqual([]);
      }
    );

    it('does not say that the server refuses every Origin when a * entry is left', () => {
      const lines = startLines('*,null');

      expect(lines).toEqual([expect.objectContaining({ entryPosition: 2 })]);
      expect(lines[0].msg).not.toContain('refuses every Origin');
    });
  });
});

describe('MCP 2026-07-28 (#85)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function postModern(body: ReturnType<typeof modernBody>, headers?: Record<string, string>) {
    const name = typeof body.params.name === 'string' ? body.params.name : undefined;
    return postMcp(body, { ...modernHeaders(body.method, name), ...headers });
  }

  it('answers server/discover with the 2026-07-28 result and no session id', async () => {
    const response = await postModern(modernBody(40, 'server/discover'));
    const body = await readMcpBody(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [MODERN],
      // The capabilities of #84.
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
        extensions: { 'io.modelcontextprotocol/ui': {} },
      },
      ttlMs: expect.any(Number),
      cacheScope: expect.any(String),
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'transcriptor-mcp' } },
    });
  });

  it('lists the tools of the stored contract', async () => {
    const body = await readMcpBody(await postModern(modernBody(41, 'tools/list')));
    const file = join(process.cwd(), 'src', 'mcp-tools-contract.json');

    expect(body.result?.resultType).toBe('complete');
    expect(body.result?.tools).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  it('runs get_transcript and answers with resultType complete', async () => {
    const execFileMock = execFile as unknown as jest.Mock;
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (e: null, r: object) => void) =>
        callback(null, { stdout: '', stderr: '' })
    );

    const body = await readMcpBody(
      await postModern(
        modernBody(42, 'tools/call', {
          name: 'get_transcript',
          arguments: { url: 'https://www.facebook.com/watch?v=1', lang: 'en_US' },
        })
      )
    );

    expect(execFileMock).toHaveBeenCalled();
    expect(body.result?.resultType).toBe('complete');
    expect(body.result?.content?.[0]?.type).toBe('text');
  });

  it.each([
    ['no Mcp-Method header', { 'mcp-method': '' }],
    ['an Mcp-Name that does not match the body', { 'mcp-name': 'get_video_info' }],
    [
      'an MCP-Protocol-Version header that does not match _meta',
      { 'mcp-protocol-version': '2025-11-25' },
    ],
  ])('answers a request with %s with HTTP 400 and -32020', async (_case, headers) => {
    const call = modernBody(43, 'tools/call', { name: 'get_transcript', arguments: { url: 'x' } });
    const sent: Record<string, string> = {
      ...modernHeaders('tools/call', 'get_transcript'),
      ...headers,
    };
    for (const [key, value] of Object.entries(sent)) if (value === '') delete sent[key];

    const response = await postMcp(call, sent);

    expect(response.status).toBe(400);
    expect((await readMcpBody(response)).error?.code).toBe(-32020);
  });

  it('answers an unsupported version with HTTP 400, -32022 and the supported versions', async () => {
    const body = modernBody(44, 'tools/list');
    body.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';

    const response = await postMcp(body, {
      ...modernHeaders('tools/list'),
      'mcp-protocol-version': '2099-01-01',
    });
    const answer = (await readMcpBody(response)) as { error?: { code?: number; data?: any } };

    expect(response.status).toBe(400);
    expect(answer.error?.code).toBe(-32022);
    expect(answer.error?.data?.supported).toContain(MODERN);
    expect(answer.error?.data?.requested).toBe('2099-01-01');
  });

  it.each([
    'io.modelcontextprotocol/protocolVersion',
    'io.modelcontextprotocol/clientCapabilities',
  ])('answers a 2026-07-28 header without %s in _meta with HTTP 400 and -32602', async (key) => {
    const body = modernBody(45, 'tools/list');
    delete body.params._meta[key];

    const response = await postMcp(body, modernHeaders('tools/list'));

    expect(response.status).toBe(400);
    expect((await readMcpBody(response)).error?.code).toBe(-32602);
  });

  it('answers an unknown method with HTTP 404 and -32601', async () => {
    const response = await postModern(modernBody(46, 'tools/unknown'));

    expect(response.status).toBe(404);
    expect((await readMcpBody(response)).error?.code).toBe(-32601);
  });

  // No list changes (#84), so the stream has nothing to wait for. The SDK ends it with the
  // completion result of the Subscriptions page, not with notifications/cancelled.
  it('acknowledges subscriptions/listen and ends the stream with a complete result', async () => {
    const response = await postModern(
      modernBody(53, 'subscriptions/listen', {
        notifications: { toolsListChanged: true, resourcesListChanged: true },
      })
    );
    // text() resolves only when the server ends the response.
    const frames = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length)) as JsonRpcBody);

    expect(response.status).toBe(200);
    expect(frames).toEqual([
      expect.objectContaining({ method: 'notifications/subscriptions/acknowledged' }),
      expect.objectContaining({
        id: 53,
        result: expect.objectContaining({ resultType: 'complete' }),
      }),
    ]);
  });

  it('refuses server/discover with a foreign Origin with 403', async () => {
    const response = await postModern(modernBody(47, 'server/discover'), {
      origin: 'https://example.com',
    });

    expect(response.status).toBe(403);
    expect((await readMcpBody(response)).error?.message).toBe(ORIGIN_NOT_ALLOWED_MESSAGE);
  });

  // The `era` field tells how much traffic still needs the 2025 protocol (ADR 001).
  it('writes era, reqId and source on the "MCP tool call" line in both eras', async () => {
    const { local, lines } = appWithLogLines();
    await local.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(local.server.address() as AddressInfo).port}/mcp`;
    const send = (body: unknown, headers: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, ...headers },
        body: JSON.stringify(body),
      }).then((response) => response.text());
    const args = { name: 'get_video_info', arguments: { url: 'not a video link' } };
    const widget = { 'transcriptor/source': 'widget' };

    try {
      await send(modernBody(48, 'tools/call', { ...args, _meta: widget }), {
        ...modernHeaders('tools/call', 'get_video_info'),
        'x-request-id': 'req-modern',
      });
      await send(toolCallBody(49, 'get_video_info', args.arguments, widget), {
        'x-request-id': 'req-legacy',
      });
    } finally {
      await local.close();
    }

    const toolLines = lines.filter((line) => line.msg === 'MCP tool call');
    expect(toolLines.map((line) => [line.era, line.reqId, line.source, line.tool])).toEqual([
      ['modern', 'req-modern', 'widget', 'get_video_info'],
      ['legacy', 'req-legacy', 'widget', 'get_video_info'],
    ]);
  });

  it('counts a 2026-07-28 tool call in mcp_tool_calls_total', async () => {
    const metric = async () => {
      const text = await (await fetch(`${baseUrl}/metrics`)).text();
      const line = text
        .split('\n')
        .find(
          (l) =>
            l.startsWith('mcp_tool_calls_total{') &&
            l.includes('tool="get_video_info"') &&
            l.includes('source="model"')
        );
      return Number(line?.split(' ').pop() ?? 0);
    };
    const before = await metric();

    await readMcpBody(
      await postModern(
        modernBody(50, 'tools/call', {
          name: 'get_video_info',
          arguments: { url: 'not a video link' },
        })
      )
    );

    expect(await metric()).toBe(before + 1);
  });

  it('writes a warn line for a refused request, and sends nothing to Sentry', async () => {
    const { local, lines } = appWithLogLines();

    const response = await local.inject({
      method: 'POST',
      url: '/mcp',
      payload: modernBody(51, 'tools/list'),
      headers: {
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
        'mcp-protocol-version': MODERN,
      },
    });
    await local.close();

    expect(response.statusCode).toBe(400);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 40,
        status: 400,
        rpcCode: -32020,
        rpcMethod: 'tools/list',
        protocolVersion: MODERN,
      })
    );
    expect(lines.filter((line) => (line.level as number) >= 50)).toEqual([]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // A proxy with an idle timeout cuts a silent response. 2025 calls get an SSE comment every
  // 15 s from the SDK transport, and the modern ones must get it too.
  it('sends an SSE comment every 15 s while a tool call runs', async () => {
    const execFileMock = execFile as unknown as jest.Mock;
    let answer: (() => void) | undefined;
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (e: null, r: object) => void
      ) => {
        const reply = () => callback(null, { stdout: '', stderr: '' });
        // The first yt-dlp run waits for the test; the runs after it answer at once.
        if (answer) reply();
        else answer = reply;
      }
    );
    // Only the keep-alive runs on setInterval; HTTP, fetch and the tool keep real time.
    jest.useFakeTimers({
      doNotFake: [
        'Date',
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
      ],
    });

    try {
      // Node sends the headers with the first frame, so the answer starts with the comment.
      const pending = postModern(
        modernBody(52, 'tools/call', {
          name: 'get_transcript',
          arguments: { url: 'https://www.facebook.com/watch?v=1', lang: 'en_US' },
        })
      );
      while (!answer) await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(15_000);
      const response = await pending;
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (pattern: RegExp) => {
        while (!pattern.test(text)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
      };

      await readUntil(/^:/m);
      expect(text).toMatch(/^:/m);
      expect(text).not.toContain('"result"');

      answer();
      await readUntil(/"result"/);
      expect(text).toContain('"resultType":"complete"');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['auto', MODERN],
    ['legacy', '2025-11-25'],
  ] as const)('serves the SDK client in mode %s with %s', async (mode, version) => {
    const client = new Client(
      { name: 'mcp-http-test', version: '1.0.0' },
      { versionNegotiation: { mode } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      expect((await client.listTools()).tools.length).toBe(8);
    } finally {
      await client.close();
    }
  });
});
