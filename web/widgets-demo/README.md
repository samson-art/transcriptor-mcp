# Widget snapshots on the landing page

The Widgets section of transcriptor-mcp.org shows static HTML snapshots
of the real widgets (`snapshots/*.html`). Each file is the serialized
DOM of the production widget bundle (`dist/ui/*.html`, the same files
the MCP server serves as `ui://` resources), captured in a browser
while the widget was rendering real data. `web/build.mjs` inlines them
into the page at the `<!-- build:widget-tiles -->` marker.

The data in the snapshots is real, recorded once with local `yt-dlp`
and `ffmpeg`:

- search: the actual top-4 YouTube results for "model context protocol";
- transcript / video info: full metadata and official English captions
  of "What is MCP?" by IBM Technology (`eur8dUO9mvE`);
- video frame: a real 640px frame of that video at 2:00
  (`yt-dlp -f 135` + `ffmpeg -ss 120 -frames:v 1`).

Thumbnails and the frame are inlined as data URIs, so the page makes no
requests to YouTube. The snapshots are inert (`pointer-events: none` on
the tile) — they are pictures made of HTML, not running apps.

To re-capture: serve the widget bundles, drive them with an MCP Apps
host (the git history of this directory has a full AppBridge-based demo
host with fixtures — commit 5ff33ae), and serialize `#root.innerHTML`
of each iframe with images swapped for data URIs.
