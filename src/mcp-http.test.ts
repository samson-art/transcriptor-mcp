import {
  app,
  cleanupExpiredSessions,
  resolvePublicBaseUrlForRequest,
  streamableSessions,
  sseSessions,
} from './mcp-http.js';

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
        'search_videos',
      ]);
      for (const tool of body.tools) {
        expect(tool).toHaveProperty('annotations');
        expect(tool.annotations?.readOnlyHint).toBe(true);
        // search_videos has idempotentHint: false, others true
        if (tool.name === 'search_videos') {
          expect(tool.annotations?.idempotentHint).toBe(false);
        } else {
          expect(tool.annotations?.idempotentHint).toBe(true);
        }
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
        expect(resource).toHaveProperty('name');
        expect(
          (resource as { uri?: string; uriTemplate?: string }).uri !== undefined ||
            (resource as { uri?: string; uriTemplate?: string }).uriTemplate !== undefined
        ).toBe(true);
      }
    });

    it('includes title for each tool (Tool Quality)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const expectedTitles: Record<string, string> = {
        get_transcript: 'Get video transcript',
        get_raw_subtitles: 'Get raw video subtitles',
        get_available_subtitles: 'Get available subtitle languages',
        get_video_info: 'Get video info',
        get_video_chapters: 'Get video chapters',
        search_videos: 'Search videos',
      };
      for (const tool of body.tools) {
        expect(tool.title).toBeTruthy();
        expect(tool.title).toBe(expectedTitles[tool.name]);
      }
    });

    it('includes parameter descriptions for get_raw_subtitles (Tool Quality)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const getRawSubtitles = body.tools.find(
        (t: { name?: string; inputSchema?: { properties?: Record<string, any> } }) =>
          t.name === 'get_raw_subtitles'
      );
      expect(getRawSubtitles).toBeDefined();
      const properties = getRawSubtitles!.inputSchema?.properties ?? {};
      const paramKeys = ['url', 'type', 'lang', 'response_limit', 'next_cursor'];
      for (const key of paramKeys) {
        expect(properties[key]).toBeDefined();
        expect(properties[key]).toHaveProperty('description');
        expect(typeof properties[key].description).toBe('string');
        expect(properties[key].description!.length).toBeGreaterThan(0);
      }
    });

    it('includes SEP-1649 fields ($schema, version, protocolVersion, transport, capabilities)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.$schema).toBe(
        'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json'
      );
      expect(body.version).toBe('1.0');
      expect(body.protocolVersion).toBe('2025-06-18');
      expect(body.transport).toEqual({ type: 'streamable-http', endpoint: '/mcp' });
      expect(body.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    });

    it('includes configSchema with optional session config (x-from non-reserved, x-to Authorization)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.configSchema).toBeDefined();
      const schema = body.configSchema as {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        $schema?: string;
        title?: string;
        additionalProperties?: boolean;
      };
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.title).toBeDefined();
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).toHaveProperty('authToken');
      const authTokenProp = (
        schema.properties as Record<
          string,
          {
            type?: string;
            description?: string;
            title?: string;
            secret?: boolean;
            'x-from'?: { header?: string };
            'x-to'?: { header?: string };
          }
        >
      ).authToken;
      expect(authTokenProp.type).toBe('string');
      expect(typeof authTokenProp.description).toBe('string');
      expect(authTokenProp['x-from']).toEqual({ header: 'x-mcp-auth-token' });
      expect(authTokenProp['x-to']).toEqual({ header: 'Authorization' });
      expect(authTokenProp.secret).toBe(true);
    });
  });

  describe('GET /.well-known/mcp/config-schema.json', () => {
    it('returns 200 with session config JSON Schema (all optional, x-from/x-to)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/config-schema.json',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      const schema = response.json();
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.properties).toHaveProperty('authToken');
      const authTokenProp = schema.properties!.authToken;
      expect(authTokenProp.type).toBe('string');
      expect(typeof authTokenProp.description).toBe('string');
      expect(authTokenProp['x-from']).toEqual({ header: 'x-mcp-auth-token' });
      expect(authTokenProp['x-to']).toEqual({ header: 'Authorization' });
      expect(authTokenProp.secret).toBe(true);
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
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toContain('authToken');
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

  describe('resolvePublicBaseUrlForRequest', () => {
    const smitheryUrl = 'https://server.smithery.ai/samson-art/transcriptor-mcp';
    const directUrl = 'https://transcriptor-mcp.comedy.cat';
    const allowedUrls = [smitheryUrl, directUrl];

    it('returns undefined when allowedUrls is empty', () => {
      const req = { headers: { host: 'server.smithery.ai' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, [])).toBeUndefined();
    });

    it('matches by Host header', () => {
      const req = { headers: { host: 'server.smithery.ai' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
    });

    it('matches by X-Forwarded-Host when present', () => {
      const req = {
        headers: { 'x-forwarded-host': 'transcriptor-mcp.comedy.cat', host: 'localhost:4200' },
      } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(directUrl);
    });

    it('strips port from Host for matching', () => {
      const req = { headers: { host: 'transcriptor-mcp.comedy.cat:443' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(directUrl);
    });

    it('returns first URL as fallback when no host match', () => {
      const req = { headers: { host: 'unknown.example.com' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
    });

    it('returns first URL when no Host header', () => {
      const req = { headers: {} } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
    });

    it('matches host case-insensitively', () => {
      const req = { headers: { host: 'Server.SmithEry.AI' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
    });

    it('with single URL behaves like MCP_PUBLIC_URL', () => {
      const single = [directUrl];
      const req = { headers: { host: 'transcriptor-mcp.comedy.cat' } } as any;
      expect(resolvePublicBaseUrlForRequest(req, single)).toBe(directUrl);
    });

    it('uses MCP_SMITHERY_PUBLIC_URL when cf-worker indicates Smithery proxy', () => {
      const envKey = 'MCP_SMITHERY_PUBLIC_URL';
      const orig = process.env[envKey];
      process.env[envKey] = smitheryUrl;
      try {
        const req = {
          headers: {
            'cf-worker': 'smithery.ai',
            'x-forwarded-host': 'transcriptor-mcp.comedy.cat',
          },
        } as any;
        expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
      } finally {
        if (orig !== undefined) process.env[envKey] = orig;
        else delete process.env[envKey];
      }
    });

    it('uses Smithery URL from allowedUrls when cf-worker indicates Smithery and MCP_SMITHERY_PUBLIC_URL unset', () => {
      const envKey = 'MCP_SMITHERY_PUBLIC_URL';
      const orig = process.env[envKey];
      delete process.env[envKey];
      try {
        const req = {
          headers: { 'cf-worker': 'smithery.ai', host: 'transcriptor-mcp.comedy.cat' },
        } as any;
        expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(smitheryUrl);
      } finally {
        if (orig !== undefined) process.env[envKey] = orig;
      }
    });

    it('falls back to allowedUrls[0] when cf-worker indicates Smithery but no Smithery URL in config', () => {
      const envKey = 'MCP_SMITHERY_PUBLIC_URL';
      const orig = process.env[envKey];
      delete process.env[envKey];
      try {
        const single = [directUrl];
        const req = { headers: { 'cf-worker': 'smithery.ai' } } as any;
        expect(resolvePublicBaseUrlForRequest(req, single)).toBe(directUrl);
      } finally {
        if (orig !== undefined) process.env[envKey] = orig;
      }
    });

    it('uses Host/X-Forwarded-Host when cf-worker is absent', () => {
      const req = {
        headers: { 'x-forwarded-host': 'transcriptor-mcp.comedy.cat', host: 'localhost:4200' },
      } as any;
      expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(directUrl);
    });
  });
});
