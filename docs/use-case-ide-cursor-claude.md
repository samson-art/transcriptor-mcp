# Use case: IDE and AI assistants (Cursor, Claude, VS Code)

Get video transcripts and summaries directly inside your IDE or AI chat — no separate API or browser. Best for developers and power users who work in Cursor, Claude Code, VS Code, or other MCP hosts.

## Who this is for

- You use **Cursor**, **Claude Code**, **VS Code** (with an MCP client), or similar tools.
- You want to **summarize a video**, **fetch a transcript**, or **search YouTube and get the first result’s transcript** without leaving the editor or chat.
- You prefer **no local install**: connect by URL (e.g. Smithery) or run the server via Docker/Node when you need full control.

## Quick start (no install)

1. Add the Transcriptor MCP server by URL in your client:
   - **URL:** `https://server.smithery.ai/samson-art/transcriptor-mcp`
   - Server page: [smithery.ai/servers/samson-art/transcriptor-mcp](https://smithery.ai/servers/samson-art/transcriptor-mcp)

2. In your AI chat, ask in natural language or use the built-in prompts.

### Example requests to the model

- *"Summarize this video: https://www.youtube.com/watch?v=VIDEO_ID"*
- *"Search for 'react hooks tutorial' and summarize the first result."*
- *"Get the transcript for https://www.youtube.com/watch?v=VIDEO_ID"*

The model will call the MCP tools (`get_transcript`, `search_videos`, etc.) for you.

## Using MCP prompts (if your client supports them)

| Prompt | Argument | What it does |
|--------|----------|--------------|
| **summarize_video** | `url` | Builds a user message that asks the model to fetch the transcript and summarize the video. |
| **search_and_summarize** | `query` (required), `url` (optional) | Asks the model to search YouTube for the query, get the first result’s transcript, and summarize; or summarize the given URL if provided. |
| **get_transcript_for_video** | `url` | Asks the model to fetch the transcript only (no summary). |

Use these from the client’s prompt list so the model gets clear instructions and tool names.

## Tool chain scenarios

### Scenario 1: Summarize one video by URL

1. You paste a video URL and ask: *"Summarize this video."*
2. The model calls **get_transcript** with that URL (auto language/type).
3. The model reads the returned text and produces a short summary.

For long videos, the tool returns the first chunk by default. For full transcript with pagination, the model can use **get_raw_subtitles** with `response_limit` and `next_cursor`.

### Scenario 2: Search and summarize

1. You ask: *"Search for 'TypeScript best practices 2024' and summarize the first video."*
2. The model calls **search_videos** with `query: "TypeScript best practices 2024"`, `limit: 5` (or similar).
3. The model picks the first result’s URL and calls **get_transcript** with it.
4. The model summarizes the transcript and replies.

### Scenario 3: Get metadata before deciding

1. You ask: *"What’s this video about? https://youtube.com/watch?v=..."*
2. The model can call **get_video_info** for title, channel, duration, description, then **get_transcript** for content, then summarize or answer questions.

## Local or self-hosted (Docker / Node)

If you prefer not to use Smithery:

- **Cursor (Docker stdio):** add an MCP server with command `docker`, args `["run", "--rm", "-i", "artsamsonov/transcriptor-mcp:latest"]`. See [quick-start.mcp.md](quick-start.mcp.md).
- **Cursor (local Node):** `command: "node"`, `args: ["dist/mcp.js"]` after `npm run build`.
- **Remote HTTP/SSE:** run stdio MCP behind [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) on port 4200 (see [quick-start.mcp.md](quick-start.mcp.md) and `docker-compose.example.yml`), then in Cursor add an SSE server with URL `http://<host>:4200/sse`. For Claude Code: `claude mcp add --transport http transcriptor http://<host>:4200/mcp`.

If you use a reverse proxy in front of mcp-proxy, set `authToken` in your client config (e.g. in Smithery) or send `Authorization: Bearer <token>` for HTTP/SSE as required by your deployment.

## See also

- [Summarize video](use-case-summarize-video.md) — minimal flow for summarization.
- [Search and get transcript](use-case-search-and-transcript.md) — search then transcript steps.
- [MCP quick start](quick-start.mcp.md) — Docker, Node, and HTTP/SSE setup.
