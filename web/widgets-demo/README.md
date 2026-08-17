# Widget snapshots on the landing page

The Widgets section of transcriptor-mcp.org shows static HTML snapshots
of the real widgets (`snapshots/*.html`). Each file is the serialized
DOM of the production widget bundle (`dist/ui/*.html`, the same files
the MCP server serves as `ui://` resources), captured in a browser while
the widget was rendering real data. `web/build.mjs` inlines them into
the page at the `<!-- build:widget-tiles -->` marker.

## What is in them, and why

Everything on show comes from NASA's own YouTube channel. NASA-produced
material is not subject to copyright in the US, so a frame, a thumbnail
and a caption line can all sit on a commercial page without a licence —
which is why the site uses these and not the developer-conference videos
the README still shows.

- **search**: the query `nasa moon base`, whose real first result is the
  video below. The other three cards are NASA uploads on the same
  subject; the set is curated to official uploads only, so every
  thumbnail on the page is NASA's own work. Titles, channels, durations
  and view counts are the real values.
- **transcript** and **video frame**: "NASA Moon Base: Lunar Landers
  (August 2026 Update)" (`Sempwv5MPMQ`, 10:15, official English
  captions, 7 chapters). The cue list holds the first twelve real
  caption lines; the frame is the launch at 8:00.
- **video info**: a different video on purpose — "2026 Total Solar
  Eclipse (Official NASA Trailer)" (`29ixFQIGZaY`, 838K views, official
  English captions). Reusing the moon-base video here gave two tiles the
  same thumbnail, which read as a rendering bug rather than two tools.

Thumbnails and the frame are inlined as data URIs, so the page makes no
requests to YouTube. The snapshots are inert — the tile disables pointer
events on the content, except that the search carousel keeps its own
scroller so all four cards stay reachable.

## Re-capturing

The capture needs an MCP Apps host to drive the widget bundles. A
working one, with a fixtures file, lives in the history of this
directory — `git show 5ff33ae:web/widgets-demo/host.mjs` and
`git show 5ff33ae:web/vite.host.config.mjs`. Restore both, write a
`fixtures.json` next to them (recorded with `yt-dlp` for metadata and
captions, `ffmpeg -ss <t> -frames:v 1` for the frame), bundle the host
with `vite build --config web/vite.host.config.mjs`, then serve a page
holding four `[data-widget]` containers with an `<iframe>` in each plus
`/widgets/host.js`, and serialize `#root.innerHTML` from every frame
with image sources swapped for data URIs. Delete the scaffolding
afterwards: the shipped site is static HTML with no runtime.
