import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { YtDlpError } from './errors.js';
import { restErrorHandler } from './rest-error-handler.js';
import {
  assertSubtitlesNotRateLimited,
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';

// This is the only test file that starts the real SDK. A second one in the same Jest worker
// adds the OpenTelemetry hooks twice, and Fastify then refuses its "opentelemetry" decorator.

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

// No platform command runs for real here. A test answers for yt-dlp, and a run that no test
// answers fails at once. Other commands run for real, because the SDK's Context integration
// reads the OS version with one for each event.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  const platformCommands = new Set(['yt-dlp', 'ffmpeg', 'ffprobe']);
  return {
    ...actual,
    execFile: jest.fn((file: string, ...rest: unknown[]) => {
      if (platformCommands.has(file)) throw new Error(`No real ${file} in this test file.`);
      return (actual.execFile as (...args: unknown[]) => unknown)(file, ...rest);
    }),
  };
});

type MockLog = {
  body: string;
  trace_id?: string;
  attributes: Record<string, { value: unknown }>;
};

// What the real SDK sends, with the options instrument.ts gives it. Only the DSN and the
// transport are the test's: the transport keeps each item here and sends nothing.
const mockSent: Sentry.Event[] = [];
const mockLogs: MockLog[] = [];
const mockPayloads: string[] = [];
const mockTransactions: Sentry.Event[] = [];
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual<typeof Sentry>('@sentry/node');
  return {
    ...actual,
    init: (options: Sentry.NodeOptions) =>
      actual.init({
        ...options,
        dsn: 'https://key@sentry.invalid/1',
        transport: () => ({
          send: (envelope: [unknown, Array<[{ type: string }, unknown]>]) => {
            for (const [item, payload] of envelope[1]) {
              mockPayloads.push(JSON.stringify(payload));
              if (item.type === 'event') mockSent.push(payload as Sentry.Event);
              if (item.type === 'log') mockLogs.push(...(payload as { items: MockLog[] }).items);
              if (item.type === 'transaction') mockTransactions.push(payload as Sentry.Event);
            }
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
      }),
  };
});

import { execFile } from 'node:child_process';
import { createLoggerWithSentryBreadcrumbs } from './logger-sentry-breadcrumbs.js';

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const videoUrl = (i: number) => `https://www.youtube.com/watch?v=${String(i).padStart(11, 'v')}`;

let app: FastifyInstance;
let mcpApp: FastifyInstance;
let mcpBaseUrl: string;

beforeAll(async () => {
  // Tracing on: this is what adds Sentry's Fastify integration.
  process.env.SENTRY_TRACES_SAMPLE_RATE = '1';
  // The PII switch must not change what the privacy test below sees.
  delete process.env.SENTRY_SEND_DEFAULT_PII;
  await import('./instrument.js');
  app = Fastify();
  app.setErrorHandler(restErrorHandler);
  app.post('/subtitles', (request) => {
    const { url } = request.body as { url: string };
    assertSubtitlesNotRateLimited(url);
    // What a platform run that answers 429 leaves behind (youtube.ts).
    noteSubtitlesRateLimited(url);
    throw new YtDlpError('rate_limited');
  });
  app.post('/fails', () => {
    throw new Error('Unplanned fault.');
  });
  await app.ready();

  const { buildMcpHttpApp } = await import('./mcp-http.js');
  mcpApp = buildMcpHttpApp({
    loggerInstance: createLoggerWithSentryBreadcrumbs({ level: 'silent' }),
  });
  // A real socket: Sentry's HTTP integration gives each request its own scope only on one.
  await mcpApp.listen({ port: 0, host: '127.0.0.1' });
  mcpBaseUrl = `http://127.0.0.1:${(mcpApp.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await mcpApp.close();
  await Sentry.close();
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});

beforeEach(() => {
  resetSubtitleRateLimitsForTests();
  mockSent.length = 0;
  mockLogs.length = 0;
  mockPayloads.length = 0;
  mockTransactions.length = 0;
});

const post = (url: string, videoUrl: string) =>
  app.inject({ method: 'POST', url, payload: { url: videoUrl } });

describe('Sentry events', () => {
  it('sends the 429 of a platform run once, and nothing for the 50 calls its hold answers', async () => {
    expect((await post('/subtitles', videoUrl(0))).statusCode).toBe(502);
    for (let i = 1; i <= 50; i++) {
      const held = await post('/subtitles', videoUrl(i));
      // The caller's answer does not change: the same 502 and text as the 429 itself.
      expect(held.statusCode).toBe(502);
      expect(held.json().message).toBe(new YtDlpError('rate_limited').message);
    }
    await Sentry.flush();

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].tags).toMatchObject({ yt_dlp_reason: 'rate_limited' });
  });

  it('sends a REST route error once, with the route tag and the requested URL', async () => {
    expect((await post('/fails', VIDEO_URL)).statusCode).toBe(500);
    await Sentry.flush();

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].tags).toMatchObject({ route: '/fails' });
    expect(mockSent[0].contexts?.request).toMatchObject({ requestUrl: VIDEO_URL });
  });

  it('sends no request headers and no request body, as the privacy policy says', async () => {
    // A real socket: Sentry's HTTP integration reads headers and the body only from one, and
    // app.inject does not go through it.
    const listener = Fastify();
    listener.setErrorHandler(restErrorHandler);
    listener.post('/fails', () => {
      throw new Error('Unplanned fault.');
    });
    await listener.listen({ port: 0, host: '127.0.0.1' });
    // Random, so that they cannot reach the event as a source line of this file (ContextLines).
    const userId = `sub-${randomUUID()}`;
    const cookie = `sid-${randomUUID()}`;
    try {
      const { port } = listener.server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/fails`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mcpal-user-id': userId,
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.9',
          'user-agent': 'openai-mcp/1.0.0 (Codex)',
          'mcp-protocol-version': '2025-11-25',
          cookie: `session=${cookie}`,
        },
        body: JSON.stringify({ url: VIDEO_URL }),
      });
      expect(response.status).toBe(500);
      await Sentry.flush();

      expect(mockSent).toHaveLength(1);
      // Only the method and the URL of the request stay: no headers, body, cookies or IP.
      expect(mockSent[0].request).toEqual({
        method: 'POST',
        url: `http://127.0.0.1:${port}/fails`,
      });
      expect(mockSent[0].user?.ip_address).toBeUndefined();
      for (const value of [userId, cookie]) {
        expect(JSON.stringify(mockSent[0])).not.toContain(value);
      }
      // The span of the request, sampled here at 1, keeps neither the headers nor the IP.
      const [transaction] = mockTransactions;
      expect(transaction?.transaction).toBe('POST /fails');
      const rootData = transaction?.contexts?.trace?.data ?? {};
      expect(rootData).toMatchObject({
        'sentry.op': 'http.server',
        'http.response.status_code': 500,
        'mcp.protocol.version': '2025-11-25',
        'mcp.client.family': 'codex',
      });
      expect(Object.keys(rootData)).not.toContain('net.peer.ip');
      const spanData = JSON.stringify(transaction);
      for (const value of [userId, cookie, '203.0.113.7', '198.51.100.9', 'openai-mcp']) {
        expect(spanData).not.toContain(value);
      }
      expect(spanData).not.toContain('http.request.header.');
    } finally {
      await listener.close();
    }
  });
});

describe('Sentry user from the gateway (#118)', () => {
  const SECRET = 'a-test-secret-of-some-length';
  const INFO_URL = 'https://www.youtube.com/watch?v=sentryUser1';
  const SLOW_URL = 'https://www.youtube.com/watch?v=sentryUser2';
  const VIDEO_JSON = { id: 'sentryUser1', title: 'A video', duration: 60, formats: [{}] };
  const execFileMock = execFile as unknown as jest.Mock;
  // The default of the mock above: platform commands fail, other commands run for real.
  const defaultExecFile = execFileMock.getMockImplementation() as (...args: unknown[]) => unknown;

  const hashOf = (userId: string) =>
    createHmac('sha256', SECRET).update(userId).digest('hex').slice(0, 16);
  const attributesOf = (log: MockLog) =>
    Object.fromEntries(Object.entries(log.attributes).map(([key, { value }]) => [key, value]));
  /** The user id belongs on the logs only, so it must reach no event and no transaction. */
  const eventsAndTransactions = () => JSON.stringify([...mockSent, ...mockTransactions]);

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    userId?: string,
    signal?: AbortSignal
  ) {
    const response = await fetch(`${mcpBaseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(userId ? { 'x-mcpal-user-id': userId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal,
    });
    return response.text();
  }

  /** Answers each yt-dlp run with `answer`. Other commands keep the default of the mock. */
  function answerYtDlp(
    answer: (args: string[], callback: (e: Error | null, r?: object) => void) => void
  ) {
    execFileMock.mockImplementation(
      (file: string, args: string[], options: unknown, callback: (e: Error | null) => void) =>
        file === 'yt-dlp' ? answer(args, callback) : defaultExecFile(file, args, options, callback)
    );
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    process.env.SENTRY_USER_HASH_SECRET = SECRET;
    // A metadata run answers with VIDEO_JSON, and the run for SLOW_URL answers 300 ms later.
    answerYtDlp((args, callback) => {
      setTimeout(
        () => callback(null, { stdout: JSON.stringify(VIDEO_JSON), stderr: '' }),
        args.includes(SLOW_URL) ? 300 : 0
      );
    });
  });

  afterEach(() => {
    delete process.env.SENTRY_USER_HASH_SECRET;
    execFileMock.mockImplementation(defaultExecFile);
  });

  it('sends one log per tool call, with an HMAC of the user id and no address', async () => {
    const userId = `sub-${randomUUID()}`;
    await callTool('get_video_info', { url: INFO_URL }, userId);
    await callTool('get_video_info', { url: 'not a video address' }, userId);
    await Sentry.flush();

    expect(mockLogs.map((log) => log.body)).toEqual(['MCP tool call', 'MCP tool call']);
    const [ok, failed] = mockLogs.map(attributesOf);
    expect(ok).toMatchObject({
      tool: 'get_video_info',
      outcome: 'ok',
      platform: 'youtube',
      source: 'model',
      'user.id': hashOf(userId),
    });
    expect(ok).not.toHaveProperty('reason');
    expect(failed).toMatchObject({
      tool: 'get_video_info',
      outcome: 'error',
      reason: 'validation',
      'user.id': hashOf(userId),
    });
    for (const attributes of [ok, failed]) {
      for (const key of ['addr', 'vid', 'host', 'url']) expect(attributes).not.toHaveProperty(key);
      expect(JSON.stringify(attributes)).not.toContain('sentryUser1');
    }
    expect(eventsAndTransactions()).not.toContain(hashOf(userId));
    // The raw id goes nowhere: not in a log, an event or a transaction.
    expect(mockPayloads.join('\n')).not.toContain(userId);
  });

  it('says which "no subtitles" answer the call got', async () => {
    const userId = `sub-${randomUUID()}`;
    // VIDEO_JSON lists no tracks, and this server does not transcribe audio here.
    await callTool('get_transcript', { url: INFO_URL }, userId);
    await Sentry.flush();

    expect(mockLogs.map(attributesOf)).toEqual([
      expect.objectContaining({
        tool: 'get_transcript',
        outcome: 'error',
        reason: 'not_found',
        answer: 'none',
        'user.id': hashOf(userId),
      }),
    ]);
  });

  it('sends no log without the secret or without the header', async () => {
    delete process.env.SENTRY_USER_HASH_SECRET;
    await callTool('get_video_info', { url: INFO_URL }, `sub-${randomUUID()}`);
    process.env.SENTRY_USER_HASH_SECRET = SECRET;
    await callTool('get_video_info', { url: INFO_URL });
    await Sentry.flush();

    expect(mockLogs).toHaveLength(0);
  });

  it('keeps the user of each request when two calls overlap', async () => {
    const slowUser = `sub-${randomUUID()}`;
    const fastUser = `sub-${randomUUID()}`;
    const slow = callTool('get_video_chapters', { url: SLOW_URL }, slowUser);
    // The second request comes while the first one still waits for its run.
    await pause(50);
    await callTool('get_video_info', { url: INFO_URL }, fastUser);
    await slow;
    // A later request without the header sends no log under any user.
    await callTool('get_video_info', { url: INFO_URL });
    await Sentry.flush();

    expect(mockLogs.map(attributesOf).map((log) => [log.tool, log['user.id']])).toEqual([
      ['get_video_info', hashOf(fastUser)],
      ['get_video_chapters', hashOf(slowUser)],
    ]);
  });

  it('logs a call whose caller left before the answer as cancelled', async () => {
    const userId = `sub-${randomUUID()}`;
    const controller = new AbortController();
    const call = callTool('get_video_chapters', { url: SLOW_URL }, userId, controller.signal);
    await pause(50);
    controller.abort();
    await expect(call).rejects.toThrow();
    // The run still ends 300 ms after it started, and the log comes then.
    await pause(400);
    await Sentry.flush();

    expect(mockLogs.map(attributesOf)).toEqual([
      expect.objectContaining({
        tool: 'get_video_chapters',
        outcome: 'error',
        reason: 'cancelled',
        'user.id': hashOf(userId),
      }),
    ]);
  });

  it('keeps the user id off the error event of a failed call', async () => {
    const userId = `sub-${randomUUID()}`;
    answerYtDlp((_args, callback) => {
      const stderr = "ERROR: [youtube] x: Sign in to confirm you're not a bot";
      callback(Object.assign(new Error('Command failed: yt-dlp'), { code: 1, stderr }));
    });
    await callTool('get_video_info', { url: INFO_URL }, userId);
    await Sentry.flush();

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].tags).toMatchObject({ yt_dlp_reason: 'bot_check' });
    expect(mockSent[0].user?.id).toBeUndefined();
    expect(eventsAndTransactions()).not.toContain(hashOf(userId));
    expect(attributesOf(mockLogs[0])).toMatchObject({
      outcome: 'error',
      reason: 'bot_check',
      'user.id': hashOf(userId),
    });
    expect(mockPayloads.join('\n')).not.toContain(userId);
    // The log starts its own trace. With the trace id of the call, Sentry links the user id to
    // the error event, whose log lines hold the requested address.
    const callTrace = mockSent[0].contexts?.trace?.trace_id;
    expect(callTrace).toEqual(expect.any(String));
    expect(mockLogs[0].trace_id).toEqual(expect.any(String));
    expect(mockLogs[0].trace_id).not.toBe(callTrace);
    expect(Object.keys(mockLogs[0].attributes)).not.toContain('sentry.trace.parent_span_id');
  });
});
