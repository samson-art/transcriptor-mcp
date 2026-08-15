# Live widget demos on the landing page

The Widgets section of transcriptor-mcp.org embeds the real production
widget bundles (`dist/ui/*.html` — the same files the MCP server serves
as `ui://` resources) in iframes. `host.mjs` plays the host side of the
MCP Apps protocol with the official `AppBridge` from
`@modelcontextprotocol/ext-apps`, so the widgets run exactly as they do
inside a chat client — data comes from `fixtures.json` instead of the
network.

## fixtures.json

Real data, recorded once with local `yt-dlp` + `ffmpeg`:

- `search`: top results of `ytsearch4:"model context protocol"`
  (flat playlist dump).
- `hero`: full `yt-dlp -J` metadata of "What is MCP?" by IBM Technology
  (`eur8dUO9mvE`) plus its official English subtitles converted to a
  plain-text transcript.
- `subtitles`: SRT tracks per video (official for the hero, auto for
  the rest), truncated to ~40 KB at a cue boundary.
- `frames`: five 640px JPEG frames of the hero video at 90/100/110/111/120s
  (`yt-dlp -f 135` + `ffmpeg -ss <t> -frames:v 1`), base64-encoded. The
  demo's `get_video_frame` handler returns the nearest recorded frame,
  so the −10s/−1s/+1s/+10s step controls work.

To refresh, rerun those commands and rebuild the JSON with the same
shape; `npm run build:site` bundles it into `/widgets/host.js`.
