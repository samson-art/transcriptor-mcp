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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { ORIGIN_NOT_ALLOWED_MESSAGE, UNEXPECTED_ERROR_MESSAGE, YtDlpError } from './errors.js';
import { buildMcpHttpApp } from './mcp-http.js';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';
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

describe('tools/call', () => {
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

  it('answers a failed transport with the generic text, not its message', async () => {
    jest
      .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockRejectedValue(new Error(PATH_ERROR));
    const { local, lines } = appWithLogLines();

    const response = await local.inject({
      method: 'POST',
      url: '/mcp',
      payload: initializeBody(),
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    });
    await local.close();

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, err: expect.objectContaining({ message: PATH_ERROR }) })
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: PATH_ERROR })
    );
  });
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
    const handleRequest = jest.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest');

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
      expect(handleRequest).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      handleRequest.mockRestore();
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
    const lines: Array<Record<string, unknown>> = [];
    const local = buildMcpHttpApp({
      loggerInstance: pino(
        { level: 'warn' },
        { write: (line: string) => lines.push(JSON.parse(line)) }
      ) as FastifyBaseLogger,
    });

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
  });
});
