<div align="center">

<img src="logo.webp" alt="Transcriptor MCP" width="120" />

# 🎬 Your assistant can't watch videos. Give it the transcript.

**One connection. Then ask Claude, ChatGPT or Cursor about any video** — transcript, chapters, metadata, even a single frame — across **11 platforms**, not just YouTube.

[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-transcriptor--mcp-6E56CF)](https://registry.modelcontextprotocol.io/v0/servers?search=transcriptor)
[![Docker](https://img.shields.io/badge/Docker-artsamsonov/transcriptor--mcp-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/artsamsonov/transcriptor-mcp)
[![MCP Apps](https://img.shields.io/badge/MCP%20Apps-4%20interactive%20widgets-8A63D2)](#-widgets)
[![License](https://img.shields.io/github/license/samson-art/transcriptor-mcp)](LICENSE)

**[Connect](#-connect-in-30-seconds) · [What to ask](#-what-you-can-ask) · [Widgets](#-widgets) · [Platforms](#-platforms) · [Self-host](#-self-host) · [FAQ](#-faq)**

</div>

---

## ⚡ Connect in 30 seconds

The hosted endpoint is:

```text
https://gateway.mcpal.io/mcp/transcriptor
```

Sign-in happens **in your browser, through your client** — there is no API key to generate, paste or rotate. Pick your client:

### 🖱️ One click

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=transcriptor&config=eyJ1cmwiOiJodHRwczovL2dhdGV3YXkubWNwYWwuaW8vbWNwL3RyYW5zY3JpcHRvciJ9)
[![Install in VS Code](https://img.shields.io/badge/Install%20in-VS%20Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=transcriptor&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fgateway.mcpal.io%2Fmcp%2Ftranscriptor%22%7D)

Both open the client, prefill the server, and start the sign-in flow.

### ⌨️ One command — Claude Code

```bash
claude mcp add --transport http transcriptor https://gateway.mcpal.io/mcp/transcriptor
```

Then run `/mcp` and approve the browser sign-in. `claude mcp list` should show `✔ Connected`.

### 🧭 No terminal

| Client | Where to click |
| --- | --- |
| **Claude** (web & desktop) | Settings → **Connectors** → **Add custom connector** → paste the URL → **Add**, then sign in ([claude.ai/settings/connectors](https://claude.ai/settings/connectors)) |
| **ChatGPT** | Settings → **Security and login** → turn on **Developer mode**, then Plugins → **+** → paste the URL. Web only, on paid plans. *(Some rollouts label this Settings → Apps & Connectors → Advanced.)* |
| **Anything else** | Any MCP client that speaks Streamable HTTP — use the JSON below |

### 🧩 Any other MCP client

```json
{
  "mcpServers": {
    "transcriptor": {
      "url": "https://gateway.mcpal.io/mcp/transcriptor"
    }
  }
}
```

> Prefer to run it yourself? Jump to [Self-host](#-self-host) — same tools, your machine, no account.

---

## 🧰 What you can ask

Eight tools. You never call them by name — just ask.

| Ask for this | Tool it uses |
| --- | --- |
| *"Summarize this video for me"* | `get_transcript` |
| *"Give me the subtitles as an SRT file"* | `get_raw_subtitles` |
| *"Is there a German track for this?"* | `get_available_subtitles` |
| *"Who published this and how many views?"* | `get_video_info` |
| *"Jump to the part about pricing"* | `get_video_chapters` |
| *"Show me what's on screen at 4:12"* | `get_video_frame` |
| *"Pull transcripts for the first 5 videos in this playlist"* | `get_playlist_transcripts` |
| *"Find recent videos about X"* | `search_videos` (YouTube) |

Three ready-made prompts ship with the server too: `get_transcript_for_video`, `summarize_video`, `search_and_summarize`.

Long transcripts are paginated rather than truncated, so nothing silently disappears mid-answer.

<details>
<summary><b>Full tool reference</b> (inputs & structured responses)</summary>

Every URL-based tool takes `url` — a link from any [supported platform](#-platforms) or a bare YouTube ID. Each returns both `content` (readable text) and `structuredContent` (typed JSON for automation).

#### `get_transcript`

Cleaned plain text — no timestamps, HTML or speaker markup. Type and language are auto-discovered. Returns the first chunk with `videoId`, `type`, `lang`, `text`, `is_truncated`, `total_length`, `start_offset`, `end_offset`, and `next_cursor` when more remains.

#### `get_raw_subtitles`

Raw SRT/VTT with pagination. Extra input: `type` (`official` | `auto`), `lang`, `response_limit` (default `50000`, min `1000`, max `200000`), `next_cursor`. Adds `format` (`srt` | `vtt`) and `content` to the response.

#### `get_available_subtitles`

Returns `official` and `auto` — sorted language-code lists. Use it to discover a language, then pass `type`/`lang` to the tools above.

#### `get_video_info`

Extended yt-dlp metadata: `title`, `description`, `uploader`, `channel`/`channelId`/`channelUrl`, `duration`, `uploadDate`, `webpageUrl`, `viewCount`, `likeCount`, `commentCount`, `tags`, `categories`, `liveStatus`/`isLive`/`wasLive`/`availability`, `thumbnail` and `thumbnails[]`.

#### `get_video_chapters`

`chapters` — an array of `{ startTime, endTime, title }`. Empty when the video has none.

#### `get_video_frame`

Input: `timecode` (`"MM:SS"` / `"HH:MM:SS.mmm"`) **or** `seconds`, plus `format` (`jpeg` | `png`), `width` (default `1280`, max `1920`, never upscaled) and `quality` (`2`–`31`, jpeg only). Returns an image block plus `timestampSeconds`, `timestamp`, `mimeType`, `sizeBytes`, `width`. Needs `ffmpeg` — already in the Docker image.

#### `get_playlist_transcripts`

Input: playlist `url` (or a watch URL with `list=`), `type`, `lang`, `format`, `playlistItems` (yt-dlp `-I` spec such as `1:5`, `1,3,7`, `-1`) and `maxItems`. Returns `results[]` of `{ videoId, text }`.

#### `search_videos`

Input: `query`, `limit` (default 10, max 50), `offset`, `uploadDateFilter` (`hour` | `today` | `week` | `month` | `year`), `response_format` (`json` | `markdown`). Returns `results[]` of `{ videoId, title, url, duration, uploader, viewCount, thumbnail }`.

</details>

---

## 🖼️ Widgets

Four tools ship an interactive UI instead of a wall of text — `get_transcript`, `get_video_info`, `get_video_frame` and `search_videos`. In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (and the ChatGPT Apps SDK) they render inline; everywhere else the same data arrives as plain text and JSON, so nothing breaks.

![Transcriptor MCP in action](example-usage.webp)

---

## 🌍 Platforms

**YouTube · Twitter/X · Instagram · TikTok · Twitch · Vimeo · Facebook · Bilibili · VK · Dailymotion · Reddit**

All URL-based tools accept links from any of them. `search_videos` is YouTube-only (yt-dlp `ytsearch`).

No video or audio files are downloaded for you — this server deals in text, metadata and single frames.

---

## 🐳 Self-host

Same tools, your infrastructure, no account.

**Streamable HTTP** (the image default, port 4200):

```bash
docker run --rm -p 4200:4200 artsamsonov/transcriptor-mcp:latest
```

Point your client at `http://localhost:4200/mcp`.

**stdio** (local client spawns the process):

```bash
docker run --rm -i artsamsonov/transcriptor-mcp:latest npm run start:mcp
```

```json
{
  "mcpServers": {
    "transcriptor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "artsamsonov/transcriptor-mcp:latest", "npm", "run", "start:mcp"]
    }
  }
}
```

Everything is optional to configure — it boots with no environment variables at all:

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_PORT` / `MCP_HOST` | `4200` / `0.0.0.0` | HTTP listener |
| `COOKIES_FILE_PATH` | — | Netscape cookies file for age-gated or sign-in-required videos (see [cookies.example.txt](cookies.example.txt)) |
| `WHISPER_MODE` | `off` | `local` or `api` to transcribe audio when a video has no subtitles (`WHISPER_BASE_URL` / `WHISPER_API_KEY`) |
| `CACHE_MODE` | `off` | `redis` + `CACHE_REDIS_URL` to cache subtitles and metadata |
| `YT_DLP_*` | — | Timeouts, proxy and JS-runtime tuning — see [.env.example](.env.example) |

`GET /health` and `GET /metrics` (Prometheus, `mcp_*` counters) are served on the same port.

<details>
<summary><b>Transport details, REST API, and development</b></summary>

**Transport.** `POST /mcp` only — `GET` and `DELETE` return `405`. The server is stateless and issues no `Mcp-Session-Id`. The Node process does **not** validate bearer tokens; terminate auth at your own reverse proxy or gateway (this is exactly what the hosted endpoint does).

**Optional REST API.** A separate Fastify image exposes the same extraction over plain HTTP:

```bash
docker run --rm -p 3000:3000 artsamsonov/transcriptor-mcp-api:latest
```

Swagger UI at `http://localhost:3000/docs`. See [docker-compose.example.yml](docker-compose.example.yml) for the full API + MCP stack.

**Development.**

```bash
npm ci
npm run build
npm run dev:mcp        # stdio, hot reload
npm run dev:mcp:http   # Streamable HTTP, hot reload
npm test
```

Requires Node.js >= 20 and `yt-dlp` on PATH (plus `ffmpeg` for frames). Useful scripts: `lint`, `type-check`, `format`, `test:coverage`, `test:e2e:api`, `test:e2e:mcp`.

**Releasing.** The runtime version comes from `package.json` ([src/version.ts](src/version.ts)). Bump it, move `[Unreleased]` changelog entries under the new version, then push a `v*` tag — CI builds both images and republishes the [MCP Registry](https://registry.modelcontextprotocol.io) entry from [server.json](server.json).

**Layout.** `src/mcp.ts` (stdio entry) · `src/mcp-http.ts` (Streamable HTTP) · `src/mcp-core.ts` (tools, prompts, widgets) · `src/youtube.ts` (yt-dlp) · `src/whisper.ts` · `src/cache.ts` · `src/index.ts` (REST API) · `load/` (k6) · `src/e2e/` (Docker smoke tests).

</details>

---

## ❓ FAQ

**Do I need an API key?**
No. The hosted endpoint uses OAuth — your client opens a browser, you sign in, done. Nothing to paste into a config file. Self-hosting needs no account at all.

**What if a video has no subtitles?**
Self-hosted, you can turn on the Whisper fallback (`WHISPER_MODE=local` or `api`) and it transcribes the audio instead.

**Some videos fail with "sign-in required".**
That's YouTube gating, not a bug. Self-hosted, export cookies and set `COOKIES_FILE_PATH` — see [cookies.example.txt](cookies.example.txt) for the expected format. Keep real cookies out of git.

**Does it download videos?**
No. Transcripts, subtitles, metadata, chapters and single frames only.

**Can I use it in production?**
Yes — that's what the Docker images are for. Put your own auth and TLS in front of `POST /mcp`; the server itself trusts its edge.

**Where do secrets live?**
Only in your environment. `WHISPER_API_KEY`, `CACHE_REDIS_URL` and cookie files are never logged or returned in responses. See [legal/](legal) for terms covering the hosted service.

---

## 🤝 Contributing

PRs welcome — fork, branch, make sure `npm test` and `npm run lint` pass, open a PR.

## 📄 License

MIT © 2025 samson-art — see [LICENSE](LICENSE).

## 💬 Support

[Issues](https://github.com/samson-art/transcriptor-mcp/issues) · [GitHub profile](https://github.com/samson-art)
