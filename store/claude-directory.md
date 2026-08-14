# Claude connectors directory — deferred draft

**Status: deferred.** Submission requires a Team or Enterprise claude.ai
organization (the portal lives in admin settings:
`claude.ai/admin-settings/directory/submissions/new`). Revisit when one is
available. Everything below stays valid; assets are shared with the OpenAI
submission (`assets/store/`).

## Listing fields (drafts)

| Field | Value |
| --- | --- |
| Server name (≤100) | Transcriptor |
| Tagline (≤55 chars) | Your AI assistant can now watch videos (38) — alt: Transcripts, chapters and frames from 11 platforms (51) |
| Categories (1–5) | Productivity, Research |
| Documentation URL | https://transcriptor-mcp.org |
| Privacy policy URL | https://transcriptor-mcp.org/privacy |
| Support contact | legal@transcriptor-mcp.org |
| Icon | `assets/store/icon-512.png` |
| Slug (permanent!) | `transcriptor` |
| Description (≤2000) | reuse the long description from `store/openai-apps.md` |

## MCP Apps carousel (PNG ≥1000px, 3–5, no prompt in image, paired prompt texts)

| Screenshot | Paired prompt |
| --- | --- |
| `assets/store/widget-search.png` | Find recent videos about the Model Context Protocol |
| `assets/store/widget-transcript.png` | Get the transcript of this video: `<YouTube URL>` |
| `assets/store/widget-video-info.png` | What is this video about? `<YouTube URL>` |
| `assets/store/widget-video-frame.png` | Show me the frame at 3:30 of `<YouTube URL>` |

## Authentication step

OAuth with dynamic client registration (`oauth_dcr`) — supported out of the box.
If DCR client churn becomes a problem, switch to Anthropic-held credentials
(`oauth_anthropic_creds`, e-mail mcp-review@anthropic.com).

## Data handling step

Underlying API: third party we don't control (YouTube + 10 platforms via
yt-dlp). Use the honest declaration from `store/openai-apps.md` → "Data
handling". No personal health data, no sponsored content.

## Use cases step

Reads data only (no writes). Users need nothing beyond a free sign-in on the
gateway. Primary use cases: summarize and quote videos with timestamps,
research talks/lectures, extract chapter navigation, capture slides as frames,
digest playlists, search YouTube.

## Notes

- Test account: same demo account as the OpenAI submission.
- The seven policy acknowledgments include: directory guidelines, first-party
  API usage, financial transactions (none), AI media generation (none — frames
  are extraction, not generation), prompt injection, conversation data
  collection (none), public documentation (the website).
- Allowed link URIs: widgets open `youtube.com` links, which we do NOT own —
  leave the field empty (users get a confirmation prompt; that is fine) and
  mention the link-out targets in free-text review notes instead.
