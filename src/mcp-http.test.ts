import {
  app,
  cleanupExpiredSessions,
  normalizeIpStringForQuota,
  normalizeMcpClientIp,
  resolvePublicBaseUrlForRequest,
  routeLabelForMcpHttpMetrics,
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

  describe('normalizeIpStringForQuota', () => {
    it('returns undefined for empty input', () => {
      expect(normalizeIpStringForQuota(undefined)).toBeUndefined();
      expect(normalizeIpStringForQuota('')).toBeUndefined();
      expect(normalizeIpStringForQuota('   ')).toBeUndefined();
    });

    it('trims and lowercases IPv6 hex', () => {
      expect(normalizeIpStringForQuota(' 2001:DB8::1 ')).toBe('2001:db8::1');
    });

    it('unwraps bracketed IPv6', () => {
      expect(normalizeIpStringForQuota('[2001:db8::1]')).toBe('2001:db8::1');
    });

    it('strips IPv6 zone identifier', () => {
      expect(normalizeIpStringForQuota('fe80::1%eth0')).toBe('fe80::1');
    });

    it('normalizes IPv4', () => {
      expect(normalizeIpStringForQuota('192.0.2.1')).toBe('192.0.2.1');
    });
  });

  describe('normalizeMcpClientIp', () => {
    it('delegates to normalizeIpStringForQuota on request.ip', () => {
      expect(normalizeMcpClientIp({ ip: ' 2001:DB8::1 ' } as any)).toBe('2001:db8::1');
      expect(normalizeMcpClientIp({ ip: undefined } as any)).toBeUndefined();
    });
  });

  describe('routeLabelForMcpHttpMetrics', () => {
    it('prefers routeOptions.url', () => {
      expect(
        routeLabelForMcpHttpMetrics({ url: '/foo', routeOptions: { url: '/mcp' } } as any)
      ).toBe('/mcp');
    });

    it('uses pathname from request url when route pattern is missing', () => {
      expect(routeLabelForMcpHttpMetrics({ url: '/health?x=1' } as any)).toBe('/health');
    });
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

  describe('GET /changelogs', () => {
    it('returns 200 with CHANGELOG.md content as markdown', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/changelogs',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/markdown');
      expect(response.payload).toContain('# Changelog');
    });
  });

  describe('GET /.well-known/mcp/server-card.json', () => {
    it('returns 200 with complete server card (tools, prompts, resources, SEP-1649, configSchema, Tool Quality)', async () => {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/mcp/server-card.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // serverInfo, authentication
      expect(body.serverInfo).toEqual({ name: 'transcriptor-mcp', version: expect.any(String) });
      expect(body.authentication.required).toBe(false);
      expect(body.authentication.schemes).toEqual([]);

      // tools
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual([
        'get_transcript',
        'get_raw_subtitles',
        'get_available_subtitles',
        'get_video_info',
        'get_video_chapters',
        'get_playlist_transcripts',
        'search_videos',
      ]);
      const expectedTitles: Record<string, string> = {
        get_transcript: 'Get video transcript',
        get_raw_subtitles: 'Get raw video subtitles',
        get_available_subtitles: 'Get available subtitle languages',
        get_video_info: 'Get video info',
        get_video_chapters: 'Get video chapters',
        get_playlist_transcripts: 'Get playlist transcripts',
        search_videos: 'Search videos',
      };
      for (const tool of body.tools) {
        expect(tool.title).toBe(expectedTitles[tool.name]);
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.idempotentHint).toBe(tool.name !== 'search_videos');
      }
      const getRawSubtitles = body.tools.find(
        (t: { name?: string }) => t.name === 'get_raw_subtitles'
      );
      const props = getRawSubtitles?.inputSchema?.properties ?? {};
      for (const key of ['url', 'type', 'lang', 'response_limit', 'next_cursor']) {
        expect(props[key]?.description).toBeDefined();
        expect(props[key].description.length).toBeGreaterThan(0);
      }

      // prompts, resources
      expect(body.prompts.length).toBeGreaterThanOrEqual(1);
      for (const prompt of body.prompts) {
        expect(prompt.name).toBeDefined();
        if (prompt.arguments?.length) {
          expect(prompt.arguments.some((a: { name: string }) => a.name === 'url')).toBe(true);
        }
      }
      expect(body.resources.length).toBeGreaterThanOrEqual(1);
      for (const resource of body.resources) {
        expect(resource.name).toBeDefined();
        expect(resource.uri ?? resource.uriTemplate).toBeDefined();
      }

      // SEP-1649
      expect(body.$schema).toBe(
        'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json'
      );
      expect(body.version).toBe('1.0');
      expect(body.protocolVersion).toBe('2025-06-18');
      expect(body.transport).toEqual({ type: 'streamable-http', endpoint: '/mcp' });
      expect(body.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });

      // configSchema
      const schema = body.configSchema;
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.properties.authToken.type).toBe('string');
      expect(schema.properties.authToken['x-from']).toEqual({ header: 'x-mcp-auth-token' });
      expect(schema.properties.authToken['x-to']).toEqual({ header: 'Authorization' });
      expect(schema.properties.authToken.secret).toBe(true);
      expect(schema.properties.apiKey.type).toBe('string');
      expect(schema.properties.apiKey['x-from']).toEqual({ header: 'x-api-key' });
      expect(schema.properties.apiKey['x-to']).toEqual({ header: 'X-Api-Key' });
      expect(schema.properties.apiKey.secret).toBe(true);
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
      expect(schema.properties).toHaveProperty('apiKey');
      const authTokenProp = schema.properties!.authToken;
      expect(authTokenProp.type).toBe('string');
      expect(typeof authTokenProp.description).toBe('string');
      expect(authTokenProp['x-from']).toEqual({ header: 'x-mcp-auth-token' });
      expect(authTokenProp['x-to']).toEqual({ header: 'Authorization' });
      expect(authTokenProp.secret).toBe(true);
      const apiKeyProp = schema.properties!.apiKey;
      expect(apiKeyProp.type).toBe('string');
      expect(typeof apiKeyProp.description).toBe('string');
      expect(apiKeyProp['x-from']).toEqual({ header: 'x-api-key' });
      expect(apiKeyProp['x-to']).toEqual({ header: 'X-Api-Key' });
      expect(apiKeyProp.secret).toBe(true);
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

    describe('fallbacks', () => {
      it('returns undefined when allowedUrls is empty', () => {
        const req = { headers: { host: 'server.smithery.ai' } } as any;
        expect(resolvePublicBaseUrlForRequest(req, [])).toBeUndefined();
      });

      it('returns first URL when no host match or no Host header', () => {
        expect(
          resolvePublicBaseUrlForRequest(
            { headers: { host: 'unknown.example.com' } } as any,
            allowedUrls
          )
        ).toBe(smitheryUrl);
        expect(resolvePublicBaseUrlForRequest({ headers: {} } as any, allowedUrls)).toBe(
          smitheryUrl
        );
      });
    });

    describe('Host matching', () => {
      it('matches by Host (strips port, case-insensitive)', () => {
        expect(
          resolvePublicBaseUrlForRequest(
            { headers: { host: 'server.smithery.ai' } } as any,
            allowedUrls
          )
        ).toBe(smitheryUrl);
        expect(
          resolvePublicBaseUrlForRequest(
            { headers: { host: 'transcriptor-mcp.comedy.cat:443' } } as any,
            allowedUrls
          )
        ).toBe(directUrl);
        expect(
          resolvePublicBaseUrlForRequest(
            { headers: { host: 'Server.SmithEry.AI' } } as any,
            allowedUrls
          )
        ).toBe(smitheryUrl);
      });

      it('with single URL behaves like MCP_PUBLIC_URL', () => {
        const single = [directUrl];
        expect(
          resolvePublicBaseUrlForRequest(
            { headers: { host: 'transcriptor-mcp.comedy.cat' } } as any,
            single
          )
        ).toBe(directUrl);
      });
    });

    describe('X-Forwarded-Host', () => {
      it('uses X-Forwarded-Host when present (or when cf-worker absent)', () => {
        const req = {
          headers: { 'x-forwarded-host': 'transcriptor-mcp.comedy.cat', host: 'localhost:4200' },
        } as any;
        expect(resolvePublicBaseUrlForRequest(req, allowedUrls)).toBe(directUrl);
      });
    });

    describe('Smithery (cf-worker)', () => {
      const envKey = 'MCP_SMITHERY_PUBLIC_URL';

      it('uses MCP_SMITHERY_PUBLIC_URL when set', () => {
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
          if (orig === undefined) {
            delete process.env[envKey];
          } else {
            process.env[envKey] = orig;
          }
        }
      });

      it('uses Smithery URL from allowedUrls when MCP_SMITHERY_PUBLIC_URL unset', () => {
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

      it('falls back to allowedUrls[0] when cf-worker indicates Smithery but no Smithery URL', () => {
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
    });
  });
});
