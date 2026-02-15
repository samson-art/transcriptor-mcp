## Documentation

This repository ships both an MCP server and an optional REST API.  
The detailed documentation is split into focused guides:

- **MCP server (stdio + HTTP/SSE)**: see [quick-start.mcp.md](quick-start.mcp.md)
- **REST API quick start & endpoints**: see [quick-start.rest.md](quick-start.rest.md)
- **Configuration & environment variables**: see [configuration.md](configuration.md)
- **Using cookies for restricted videos**: see [cookies.md](cookies.md)
- **Redis cache**: see [caching.md](caching.md)
- **Load testing (k6)**: see `load/load-testing.md`

**Use cases (MCP):**

- [Summarize video](use-case-summarize-video.md) — fetch transcript and summarize with the model
- [Search and get transcript](use-case-search-and-transcript.md) — search YouTube, then get transcript of chosen videos

If you are unsure where to start:

- Use the **MCP guide** if you primarily work from Cursor, Claude Code, n8n, or another MCP host.
- Use the **REST API guide** if you want to call HTTP endpoints directly (e.g. from scripts, backend services, or API clients).

