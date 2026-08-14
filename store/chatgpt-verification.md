# ChatGPT developer-mode verification checklist

Run once before submission, and again after any gateway change. ChatGPT web,
paid plan, developer mode on (Settings → Security and login → Developer mode;
some releases: Settings → Apps & Connectors → Advanced).

Record the result of each item as `[x]` pass / `[!]` fail with a note.

## Connection

- [ ] Add connector `https://gateway.mcpal.io/mcp/transcriptor`; OAuth completes in the browser and the tool list shows all 8 tools.
- [ ] Reconnect after signing out works (token refresh path).

## Widget tools (via the MCP Apps / ext-apps bridge)

For each of `search_videos`, `get_transcript`, `get_video_info`, `get_video_frame`:

- [ ] Widget renders in the conversation (not only raw JSON/text).
- [ ] Status strings show during the call ("Searching videos…" → "Videos found", "Fetching transcript…" → "Transcript ready", "Fetching video info…" → "Video info ready", "Capturing frame…" → "Frame captured").
- [ ] Thumbnails from `i.ytimg.com` load (CSP `resourceDomains` honored).
- [ ] Links out to `youtube.com` open in a new tab.
- [ ] Light theme and dark theme both correct (toggle ChatGPT theme).
- [ ] Resize / expand behaves sanely; no clipped content.
- [ ] Browser console: no CSP violations, no uncaught errors.

## Plain tools

- [ ] `get_raw_subtitles` returns SRT/VTT text with pagination fields.
- [ ] `get_available_subtitles` returns official + auto language lists.
- [ ] `get_video_chapters` returns chapters (test a video that has them).
- [ ] `get_playlist_transcripts` on a 3-video playlist completes (long-call path).

## Prompts

- [ ] Note whether ChatGPT surfaces the 3 registered MCP prompts (`get_transcript_for_video`, `summarize_video`, `search_and_summarize`) — record for release notes; support varies by client.

## Negative path

- [ ] Unavailable video URL → error message is user-legible, not a stack trace.
- [ ] Unsupported site URL → validation error naming supported platforms.
