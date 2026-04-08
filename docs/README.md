## Documentation

This repository ships both an MCP server and an optional REST API. **Supported platforms**: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit. Connect with **no install** via [Smithery](https://smithery.ai/servers/samson-art/transcriptor-mcp) or [Glama](https://glama.ai/mcp/servers/samson-art/transcriptor-mcp).

The detailed documentation is split into focused guides:

- **MCP server (stdio + HTTP/SSE)**: see [quick-start.mcp.md](quick-start.mcp.md)
- **REST API quick start & endpoints**: see [quick-start.rest.md](quick-start.rest.md)
- **Configuration & environment variables**: see [configuration.md](configuration.md) — includes self-configurable Whisper fallback and Redis caching
- **Using cookies for restricted videos**: see [cookies.md](cookies.md)
- **Redis cache**: see [caching.md](caching.md)
- **Load testing (k6)**: see `load/load-testing.md`
- **Migration audit (stdio + mcp-proxy vs in-repo MCP HTTP):** [mcp-http-proxy-integration-audit.md](mcp-http-proxy-integration-audit.md) — Smithery/Glama/E2E impact and where metrics, rate limits, and auth move

**Use cases (MCP):**

- [Summarize video](use-case-summarize-video.md) — fetch transcript and summarize with the model
- [Search and get transcript](use-case-search-and-transcript.md) — search YouTube, then get transcript of chosen videos
- [IDE and AI assistants (Cursor, Claude, VS Code)](use-case-ide-cursor-claude.md) — scenarios for developers and power users: Smithery, prompts, tool chains
- [No-code automation (n8n)](use-case-n8n-automation.md) — workflows with streamable HTTP: search → transcript, playlist batch, pagination
- [Researchers and batch processing](use-case-researchers-batch.md) — search filters, playlist transcripts, pagination for long videos; REST API and self-host
- [Self-hosted and enterprise](use-case-self-hosted.md) — Docker, auth, Redis, Prometheus, Sentry, and monitoring

If you are unsure where to start:

- Use the **MCP guide** if you primarily work from Cursor, Claude Code, n8n, or another MCP host.
- Use the **REST API guide** if you want to call HTTP endpoints directly (e.g. from scripts, backend services, or API clients).

