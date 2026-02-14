import { app, cleanupExpiredSessions, streamableSessions, sseSessions } from './mcp-http.js';

jest.mock('./yt-dlp-check.js', () => ({
  checkYtDlpAtStartup: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./mcp-core.js', () => ({
  createMcpServer: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(undefined),
  }),
}));

describe('mcp-http', () => {
  afterEach(() => {
    streamableSessions.clear();
    sseSessions.clear();
    jest.clearAllMocks();
  });

  describe('cleanupExpiredSessions', () => {
    it('removes streamable sessions older than TTL', () => {
      const ttlMs = 1000;
      const oldSession = {
        server: {} as any,
        transport: {} as any,
        createdAt: Date.now() - ttlMs - 100,
      };
      const freshSession = {
        server: {} as any,
        transport: {} as any,
        createdAt: Date.now() - 100,
      };
      streamableSessions.set('expired-id', oldSession);
      streamableSessions.set('fresh-id', freshSession);

      cleanupExpiredSessions(ttlMs);

      expect(streamableSessions.has('expired-id')).toBe(false);
      expect(streamableSessions.has('fresh-id')).toBe(true);
    });

    it('removes SSE sessions older than TTL', () => {
      const ttlMs = 500;
      const oldSession = {
        server: {} as any,
        transport: {} as any,
        createdAt: Date.now() - ttlMs - 50,
      };
      sseSessions.set('expired-sse', oldSession);

      cleanupExpiredSessions(ttlMs);

      expect(sseSessions.has('expired-sse')).toBe(false);
    });

    it('leaves sessions within TTL', () => {
      const ttlMs = 5000;
      const session = {
        server: {} as any,
        transport: {} as any,
        createdAt: Date.now() - 100,
      };
      streamableSessions.set('within-ttl', session);

      cleanupExpiredSessions(ttlMs);

      expect(streamableSessions.has('within-ttl')).toBe(true);
    });
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /.well-known/mcp/server-card.json', () => {
    it('returns 200 with server card (serverInfo, tools, no auth when token unset)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      type ServerCard = {
        serverInfo: { name: string; version: string };
        authentication: { required: boolean; schemes: string[] };
        tools: Array<{
          name: string;
          annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
        }>;
        prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }>;
        resources: Array<{ name: string; uri: string }>;
      };
      const body: ServerCard = response.json();
      expect(body.serverInfo).toEqual({ name: 'transcriptor-mcp', version: expect.any(String) });
      expect(body.authentication.required).toBe(false);
      expect(body.authentication.schemes).toEqual([]);
      expect(body.tools.map((t) => t.name)).toEqual([
        'get_transcript',
        'get_raw_subtitles',
        'get_available_subtitles',
        'get_video_info',
        'get_video_chapters',
      ]);
      for (const tool of body.tools) {
        expect(tool).toHaveProperty('annotations');
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          idempotentHint: true,
        });
      }
      expect(body.prompts.length).toBeGreaterThanOrEqual(1);
      for (const prompt of body.prompts) {
        expect(prompt).toHaveProperty('name');
        expect(typeof prompt.name).toBe('string');
        if (prompt.arguments?.length) {
          const urlArg = prompt.arguments.find((a) => a.name === 'url');
          expect(urlArg).toBeDefined();
        }
      }
      expect(body.resources.length).toBeGreaterThanOrEqual(1);
      for (const resource of body.resources) {
        expect(resource).toHaveProperty('uri');
        expect(resource).toHaveProperty('name');
      }
    });
  });

  describe('auth', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns 401 for /mcp when MCP_AUTH_TOKEN set and no Authorization header', async () => {
      process.env.MCP_AUTH_TOKEN = 'test-secret';
      const { app: appWithAuth } = await import('./mcp-http.js');
      await appWithAuth.ready();

      const response = await appWithAuth.inject({
        method: 'GET',
        url: '/mcp',
        headers: {},
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 for /mcp when token is wrong', async () => {
      process.env.MCP_AUTH_TOKEN = 'test-secret';
      const { app: appWithAuth } = await import('./mcp-http.js');
      await appWithAuth.ready();

      const response = await appWithAuth.inject({
        method: 'GET',
        url: '/mcp',
        headers: { Authorization: 'Bearer wrong-token' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('allows /health without auth even when MCP_AUTH_TOKEN set', async () => {
      process.env.MCP_AUTH_TOKEN = 'test-secret';
      const { app: appWithAuth } = await import('./mcp-http.js');
      await appWithAuth.ready();

      const response = await appWithAuth.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('rate limit', () => {
    it('registers rate limit plugin and accepts requests within limit', async () => {
      // Rate limit is configured from MCP_RATE_LIMIT_MAX (default 100).
      // Full rate-limit behavior (429) is verified in e2e/Docker smoke tests.
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    });
  });
});
