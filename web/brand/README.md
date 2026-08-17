# Brand assets

`mark.svg` is the source of truth: a terracotta disc with a cream play
triangle, and nothing else. It reads the same at 16px in a browser tab as
it does at 1024px on Docker Hub, and it matches the mark the pages draw in
CSS for the header.

`og.html` is the 1200×630 social preview, built from the same mark plus
the site's own type (Lora, JetBrains Mono).

Everything else is rendered from those two files with headless Chrome
(`--allow-file-access-from-files` lets the page read the sibling SVG and
the fonts in `web/fonts/`):

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BRAND="$PWD/web/brand"

# social preview -> web/og-image.png
"$CHROME" --headless --disable-gpu --allow-file-access-from-files \
  --force-device-scale-factor=1 --hide-scrollbars --virtual-time-budget=3000 \
  --window-size=1200,630 --screenshot=web/og-image.png "file://$BRAND/og.html"
```

For the raster icons, point a minimal page at `mark.svg` sized to the
target (512 → `web/icon-512.png`, 180 → `web/apple-touch-icon.png`,
1024 → `logo.webp` via `cwebp -q 92`). `sips` reads webp but cannot write
it, hence `cwebp`.

`logo.webp` at the repository root is the one file the outside world
reads: the README header, the Docker Hub description and the MCP Registry
icon in `server.json` all point at it, so regenerating it updates all
three. The Docker Hub account avatar is separate and is uploaded by hand
(`assets/store/logo-mark-512.png` is kept ready for that).
