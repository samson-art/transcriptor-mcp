# OpenAI apps directory — submission collateral

Paste-ready field values for the submission portal at `platform.openai.com/plugins`
(submission type: **MCP-only**). Prerequisites before this form: verified developer
identity on the OpenAI Platform, "Apps Management" write access, and the
`transcriptor-mcp.org` domain-verification TXT record.

## Info

| Field | Value |
| --- | --- |
| App name | Transcriptor |
| Logo | `assets/store/icon-512.png` (512×512 PNG) |
| Category | Productivity (alt: Research, Media) |
| Website | https://transcriptor-mcp.org |
| Support | legal@transcriptor-mcp.org |
| Privacy policy | https://transcriptor-mcp.org/privacy |
| Terms of service | https://transcriptor-mcp.org/terms |

### Short description

> Your AI assistant can now watch videos: transcripts, chapters, metadata and frames from YouTube and 10 more platforms.

### Long description

> Transcriptor lets ChatGPT work with video the way it works with text. Paste a link from YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion or Reddit, and ask for a summary, a quote with its timestamp, the chapter list, the publisher and view counts, or the exact frame at 4:12.
>
> Eight read-only tools cover the whole workflow: cleaned plain-text transcripts with pagination for long videos, raw SRT/VTT subtitles, the list of available caption languages, extended metadata, chapter markers, single still frames at any timecode, batch transcripts for playlists, and YouTube search. Four tools render interactive widgets in the chat: a search carousel, a searchable timed transcript, a metadata card, and a frame viewer with step controls.
>
> The service retrieves only public captions, metadata, thumbnails and single still frames — it never downloads or redistributes video or audio files. Sign-in takes one browser round-trip; there are no API keys to manage. The server is open source (MIT) and can also be self-hosted.

## MCP

| Field | Value |
| --- | --- |
| Server URL | `https://gateway.mcpal.io/mcp/transcriptor` (universal — same URL for every user) |
| Transport | Streamable HTTP, stateless |
| Authentication | OAuth 2.1 authorization-code + PKCE (S256). Discovery: 401 + `WWW-Authenticate: resource_metadata=…`; protected resource metadata at `/.well-known/oauth-protected-resource/mcp/transcriptor`; dynamic client registration supported; scopes `openid profile email offline_access`; no client secret required (public client, `token_endpoint_auth_methods_supported` includes `none`). |
| Domain verification | `transcriptor-mcp.org` (TXT record from the portal) |

### Tool annotations (all 8 tools)

Every tool: `title` + `readOnlyHint: true` + `openWorldHint: true` (the tools
retrieve content from external video platforms). `idempotentHint: true` on all
except `search_videos` (`false` — result order changes as platforms update).
No write or destructive tools.

## Data handling — honest declaration

> The server retrieves content from YouTube and ten other video platforms. These
> are third-party platforms; we have no partnership or controlled-API relationship
> with them.
>
> Mitigations and scope limits: the service retrieves only publicly available
> captions, metadata, thumbnails and single still frames that the platforms serve
> to any signed-out viewer. It does not download full videos, does not
> redistribute media, and does not bypass DRM, paywalls, age gates or any access
> control. It holds no credentials for YouTube or any platform. Retrieval is
> user-initiated, one video per request, transiently processed; there is no
> crawling, bulk scraping or dataset building, and per-user rate limits are
> enforced at the gateway. A rights-holder contact route exists
> (legal@transcriptor-mcp.org, Terms of Service §10) with URL/channel/platform
> blocking on upheld complaints. No conversation data is collected beyond tool
> inputs; nothing is used for model training (Privacy Policy).

Do **not** claim YouTube Data API usage — the extraction uses yt-dlp.

## Starter prompts

1. Summarize this video for me: `<video URL>`
2. Find recent videos about the Model Context Protocol
3. What is this video about, who published it, and how many views does it have? `<video URL>`
4. Show me the frame at 4:12 of `<video URL>`
5. Get the transcripts of the first 3 videos in this playlist and give me one digest: `<playlist URL>`
6. Is there a German subtitle track for this video? `<video URL>`

## Test cases

### Positive (expected behavior)

1. **Transcript.** "Summarize this video: https://www.youtube.com/watch?v=jNQXAC9IVRw" → `get_transcript` returns the caption text; ChatGPT produces a short summary. The transcript widget may render with the video card and timed captions.
2. **Search.** "Find recent videos about the Model Context Protocol" → `search_videos` returns a result list; the carousel widget renders cards with thumbnails, durations and view counts.
3. **Metadata.** "Who published this and how many views? https://www.youtube.com/watch?v=jNQXAC9IVRw" → `get_video_info` returns channel, upload date, view/like counts; the info widget renders.
4. **Frame.** "Show me the first frame of https://www.youtube.com/watch?v=jNQXAC9IVRw" → `get_video_frame` returns an image block; the frame widget renders with step controls.
5. **Chapters.** "List the chapters of `<any YouTube video with chapters, e.g. a recent conference keynote>`" → `get_video_chapters` returns start/end times and titles, or an empty list with a clear "no chapters" message.
6. **Languages.** "Which subtitle languages are available for https://www.youtube.com/watch?v=jNQXAC9IVRw?" → `get_available_subtitles` returns `official` and `auto` language lists.

### Negative (expected errors are user-legible, never stack traces)

1. **Unavailable video.** "Get the transcript of https://www.youtube.com/watch?v=aaaaaaaaaaa" → clear "video unavailable / not found" error.
2. **Unsupported site.** "Get the transcript of https://example.com/article" → validation error naming the supported platforms.
3. **Timestamp beyond duration.** "Show me the frame at 10:00 of https://www.youtube.com/watch?v=jNQXAC9IVRw" (a 19-second video) → clear "timestamp beyond video duration" error.

## Demo account

Sign-in is a standard OAuth browser flow on the MCPal gateway; any reviewer can
register. Provide a pre-populated demo account anyway:

- E-mail: `<demo account e-mail — from password manager>`
- Password: `<from password manager>`
- Access instructions: add the server URL in ChatGPT (developer mode or the
  submission sandbox), complete the OAuth redirect, sign in with the credentials
  above, approve consent. Every tool works immediately after.

## Country availability

All countries.

## Release notes (v1.2.x line)

> Transcriptor turns video into something your AI can read: transcripts, raw
> subtitles, caption-language lists, metadata, chapters, single frames, playlist
> digests and YouTube search — eight read-only tools over one MCP endpoint.
> This release adds native Streamable HTTP transport, four interactive widgets
> (search carousel, timed transcript, metadata card, frame viewer), pagination
> for long transcripts, and publication in the official MCP Registry.
