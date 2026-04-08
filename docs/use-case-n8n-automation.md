# Use case: No-code automation (n8n)

Use Transcriptor MCP from n8n (or other MCP clients) to build workflows that search videos, fetch transcripts, and process playlists — without writing code.

## Who this is for

- You build **automation workflows** in **n8n** or similar tools that support MCP (Model Context Protocol).
- You need pipelines like: **search videos → get transcript → summarize or analyze**, or **batch process a playlist** and get all transcripts.
- You want **streamable HTTP** so the MCP server runs on a host (e.g. your server or Docker) and n8n connects by URL.

## Connect n8n to Transcriptor MCP

1. **Run the MCP server over HTTP** (streamable HTTP on port 4200): stdio MCP behind [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy), e.g.
   - Docker: `docker run -p 4200:4200 artsamsonov/transcriptor-mcp mcp-proxy --pass-environment --host=0.0.0.0 --port=4200 -- node --import ./dist/instrument.js dist/mcp.js`
   - Or use `docker-compose` / your own host; see [quick-start.mcp.md](quick-start.mcp.md).

2. **In n8n**, add the MCP server (MCP Client Tool or equivalent):
   - **MCP Server URL:** `http://<host>:4200/mcp` (streamable HTTP).
   - If you protect the endpoint with a reverse proxy in front of mcp-proxy, configure the client to send `Authorization: Bearer <token>` as needed.

3. **Proxy note:** If n8n runs behind a reverse proxy that sets `X-Forwarded-For`, you may need to set `N8N_PROXY_HOPS` (e.g. `1`) so the server does not reject requests. See the main [README](https://github.com/samson-art/transcriptor-mcp#readme) for details.

## Example workflows

### Workflow 1: Search → transcript → summarize

1. **Trigger** (schedule, webhook, or manual).
2. **MCP tool: search_videos**
   - `query`: e.g. "product launch keynote 2024"
   - `limit`: 5
   - Output: list of videos with `videoId`, `title`, `url`, `uploader`, `viewCount`.
3. **Process first result** (e.g. get `url` from first item).
4. **MCP tool: get_transcript**
   - `url`: from step 2.
   - Output: cleaned plain text (first chunk).
5. **Send to LLM or another node** for summarization, extraction, or storage.

For **full transcript** (long videos), use **get_raw_subtitles** with `response_limit` and repeat with `next_cursor` until `is_truncated` is false.

### Workflow 2: Playlist transcripts in batch

1. **Trigger** with a playlist URL (e.g. `https://www.youtube.com/playlist?list=...`).
2. **MCP tool: get_playlist_transcripts**
   - `url`: playlist URL (or watch URL with `list=` parameter).
   - Optional: `playlistItems: "1:10"` (first 10), `maxItems: 20`, `lang: "en"`, `type: "auto"`.
   - Output: `results` array of `{ videoId, text }`.
3. **Loop or process** each item (e.g. save to DB, send to NLP, or aggregate for a report).

You can combine with **get_video_info** per `videoId` if you need metadata (title, channel, duration) alongside the transcript.

### Workflow 3: Raw subtitles with pagination

For **long videos** where you need the full SRT/VTT or exact timestamps:

1. **MCP tool: get_raw_subtitles**
   - `url`: video URL
   - `response_limit`: 50000 (default; max 200000)
   - Optional: `type`, `lang`, `format` (srt, vtt, ass, lrc).
2. If the response has `is_truncated: true`, call **get_raw_subtitles** again with the same `url` and `next_cursor` from the previous response.
3. Repeat until `is_truncated` is false, then concatenate or store the chunks.

## Tools reference (n8n)

| Tool | Typical use in n8n |
|------|--------------------|
| **search_videos** | Find videos by query; optional `uploadDateFilter`, `matchFilter`, `limit`, `offset`. |
| **get_transcript** | Plain-text transcript (URL only; auto language). Good for summaries and LLM input. |
| **get_raw_subtitles** | Raw SRT/VTT with pagination (`response_limit`, `next_cursor`) for long content. |
| **get_playlist_transcripts** | Batch transcripts for many videos from one playlist URL. |
| **get_video_info** | Metadata (title, channel, duration, tags, etc.) for SEO or filtering. |
| **get_available_subtitles** | List official/auto languages before choosing `type`/`lang` in get_raw_subtitles. |

All tools accept a **video URL** from any supported platform (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or a YouTube video ID.

## See also

- [MCP quick start](quick-start.mcp.md) — HTTP/SSE and Docker setup.
- [Search and get transcript](use-case-search-and-transcript.md) — tool sequence for search + transcript.
- [Configuration](configuration.md) — env vars (e.g. rate limits, Redis) when running the server.
