/**
 * Builds the static site for transcriptor-mcp.org into dist-site/.
 * The markdown files in legal/ stay the source of truth; this script
 * renders them into the HTML shell (web/template.html) and copies the
 * landing page and image assets alongside them.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { SERVER_URL, clients, installLinks, tools } from './clients.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(
  await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')
);
const out = path.join(root, 'dist-site');

const REPO_URL = 'https://github.com/samson-art/transcriptor-mcp';
const SITE_URL = 'https://transcriptor-mcp.org';

const legalPages = [
  { source: 'legal/TERMS_OF_SERVICE.md', dir: 'terms' },
  { source: 'legal/PRIVACY_POLICY.md', dir: 'privacy' },
  { source: 'legal/EULA.md', dir: 'eula' },
];

// Cross-document links inside legal/*.md point at sibling markdown files;
// on the website those documents live at clean URLs instead.
const linkRewrites = [
  [/href="(?:\.\/)?TERMS_OF_SERVICE\.md(#[^"]*)?"/g, 'href="/terms$1"'],
  [/href="(?:\.\/)?PRIVACY_POLICY\.md(#[^"]*)?"/g, 'href="/privacy$1"'],
  [/href="(?:\.\/)?EULA\.md(#[^"]*)?"/g, 'href="/eula$1"'],
  [/href="\.\.\/LICENSE"/g, `href="${REPO_URL}/blob/main/LICENSE"`],
  [/href="\.\.\/README\.md(#[^"]*)?"/g, `href="${REPO_URL}#readme"`],
];

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'assets'), { recursive: true });

const template = await readFile(path.join(root, 'web/template.html'), 'utf8');

for (const page of legalPages) {
  const markdown = await readFile(path.join(root, page.source), 'utf8');
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'Transcriptor MCP';
  let content = marked.parse(markdown);
  for (const [pattern, replacement] of linkRewrites) {
    content = content.replace(pattern, replacement);
  }
  // Replacer functions, not strings: a "$&" in the legal text would otherwise
  // be interpreted as a substitution pattern and corrupt the page.
  const html = template
    .replaceAll('{{title}}', () => title)
    .replaceAll('{{path}}', () => `/${page.dir}/`)
    .replace('{{content}}', () => content);
  await mkdir(path.join(out, page.dir), { recursive: true });
  await writeFile(path.join(out, page.dir, 'index.html'), openExternalLinksInNewTab(html));
  console.log(`built /${page.dir} from ${page.source}`);
}

const esc = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pretty = (config) => JSON.stringify(config, null, 2);

const installLabels = { cursor: 'Add to Cursor', vscode: 'Add to VS Code', lmstudio: 'Add to LM Studio' };

function renderPanelBody(client) {
  const parts = [];
  if (client.heading) parts.push(`<h3>${client.heading}</h3>`);
  if (client.kind === 'steps') {
    parts.push(`<ol class="steps">\n${client.steps.map((s) => `          <li>${s}</li>`).join('\n')}\n        </ol>`);
  }
  if (client.install) {
    parts.push(
      `<div class="install-cta">` +
        `<a class="install-btn" href="${installLinks[client.install]}">⚡ ${installLabels[client.install]}</a>` +
        `<span class="or-manual">or add manually:</span>` +
        `</div>`
    );
  }
  if (client.kind === 'json' || client.kind === 'text') {
    parts.push(`<p class="cfg-file">Add to <code>${esc(client.file)}</code></p>`);
  }
  if (client.kind === 'command' || client.kind === 'json' || client.kind === 'text') {
    const text =
      client.kind === 'command'
        ? client.command
        : client.kind === 'text'
          ? client.text
          : pretty(client.config);
    const label = client.kind === 'command' ? 'Copy command' : 'Copy config';
    const copyIcon =
      '<svg class="i-copy" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const doneIcon =
      '<svg class="i-done" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20 6 9 17l-5-5"/></svg>';
    parts.push(
      `<div class="pre-wrap">` +
        `<pre id="cfg-${client.id}">${esc(text)}</pre>` +
        `<button type="button" class="copy-btn" data-icon data-copy-target="#cfg-${client.id}"` +
        ` aria-label="${label}" title="${label}">${copyIcon}${doneIcon}</button>` +
        `</div>`
    );
  }
  if (client.after) parts.push(`<p class="cfg-after">${client.after}</p>`);
  parts.push(`<div class="docs-row"><a class="docs-link" href="${client.docs}">${client.docsLabel}</a></div>`);
  return parts.map((p) => `        ${p}`).join('\n');
}

function renderClients() {
  const chips = clients
    .map(
      (c, i) =>
        `<button class="chip" role="tab" type="button" id="chip-${c.id}" data-client="${c.id}"` +
        ` aria-controls="panel-${c.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${c.label}</button>`
    )
    .join('\n          ');
  const panels = clients
    .map(
      (c, i) =>
        `<div class="client-panel" role="tabpanel" id="panel-${c.id}" aria-labelledby="chip-${c.id}"${i === 0 ? '' : ' hidden'}>\n` +
        `${renderPanelBody(c)}\n      </div>`
    )
    .join('\n      ');
  return `<div class="switcher">
      <div class="switcher-bar">
        <span class="switcher-label">Your client:</span>
        <div class="chips" role="tablist" aria-label="Choose your MCP client">
          ${chips}
        </div>
      </div>
      <div class="panel-stack">
      ${panels}
      </div>
    </div>`;
}

function renderLlmsTxt() {
  const connect = clients
    .map((c) => {
      const how = c.llms ?? (c.kind === 'command' ? c.command.replace(/\n/g, ' && ') : `add ${JSON.stringify(c.config)} to ${c.file}`);
      return `- [${c.label}](${c.docs}): ${how}`;
    })
    .join('\n');
  return `# Transcriptor MCP

> One MCP server that gives Claude, ChatGPT, Cursor and any MCP client transcripts, chapters, metadata and still frames from YouTube and 10 more video platforms.

Endpoint: ${SERVER_URL} (Streamable HTTP; OAuth 2.1 browser sign-in on first connection, no static API keys).
Eight read-only tools; four of them render interactive widgets in clients that support MCP Apps or the ChatGPT Apps SDK.
Platforms: YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit. Search is YouTube only.
The server returns text, metadata and single still frames. It never returns video or audio files.
Self-host (MIT): docker run --rm -p 4200:4200 artsamsonov/transcriptor-mcp:latest

## Tools

${tools.map((t) => `- ${t.name}: ${t.desc}`).join('\n')}

## Connect

${connect}

## Docs

- [README](${REPO_URL}#readme): full tool reference, widgets and self-host guide
- [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=transcriptor): registry entry
- [Terms of Service](https://transcriptor-mcp.org/terms)
- [Privacy Policy](https://transcriptor-mcp.org/privacy)
`;
}

/**
 * Sends every link that leaves the site to a new tab. Applied to the finished
 * HTML rather than to each anchor by hand, so the landing page, the generated
 * client panels and the legal documents rendered from markdown all follow the
 * same rule. Relative links, in-page anchors, mailto: and our own absolute
 * URLs are left alone.
 */
function openExternalLinksInNewTab(html) {
  return html.replace(/<a\s+([^>]*?)>/gi, (tag, attrs) => {
    const href = attrs.match(/href="([^"]*)"/i)?.[1];
    if (!href || !/^https?:\/\//i.test(href) || href.startsWith(SITE_URL)) return tag;
    if (/\starget=/i.test(` ${attrs}`)) return tag;
    const rel = /\srel=/i.test(` ${attrs}`) ? '' : ' rel="noopener noreferrer"';
    return `<a ${attrs} target="_blank"${rel}>`;
  });
}

// Structured data for the landing page. Only facts already stated on the page
// or in the repository — no claims about price or ratings.
function renderJsonLd() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Transcriptor MCP',
    url: SITE_URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    description:
      'One MCP server that gives Claude, ChatGPT, Cursor and any MCP client transcripts, chapters, metadata and frames from YouTube and 10 more video platforms.',
    image: `${SITE_URL}/og-image.png`,
    license: 'https://opensource.org/licenses/MIT',
    softwareVersion: version,
    author: {
      '@type': 'Person',
      name: 'Artem Samsonov',
      url: 'https://www.linkedin.com/in/artem-samsonov-284a66105/',
    },
    sameAs: [
      REPO_URL,
      'https://hub.docker.com/r/artsamsonov/transcriptor-mcp',
      'https://registry.modelcontextprotocol.io/v0/servers?search=transcriptor',
    ],
    featureList: tools.map((t) => `${t.name}: ${t.desc}`),
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function renderSitemap() {
  const paths = ['/', '/terms/', '/privacy/', '/eula/'];
  const urls = paths
    .map(
      (p) =>
        `  <url><loc>${SITE_URL}${p}</loc><changefreq>${p === '/' ? 'weekly' : 'yearly'}</changefreq>` +
        `<priority>${p === '/' ? '1.0' : '0.3'}</priority></url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// The landing page ships generated markup: web/index.html carries marker
// comments that this build replaces. Throw rather than emit a page with a
// silently missing section if a marker is ever renamed.
// The widget tiles are static snapshots of the real widgets rendered
// with real data (see web/widgets-demo/README.md).
const WIDGET_TILES = [
  // scrolls: the captured widget is wider than a tile at every breakpoint,
  // so its frame gets the scroll affordance.
  { id: 'search', caption: '<code>search_videos</code> · a carousel of result cards', scrolls: true },
  { id: 'video-info', caption: '<code>get_video_info</code> · metadata and caption languages' },
  { id: 'transcript', caption: '<code>get_transcript</code> · searchable timed captions' },
  { id: 'video-frame', caption: '<code>get_video_frame</code> · a frame with step controls' },
];

async function renderWidgetTiles() {
  const tiles = [];
  for (const tile of WIDGET_TILES) {
    const html = await readFile(
      path.join(root, 'web/widgets-demo/snapshots', `${tile.id}.html`),
      'utf8'
    );
    tiles.push(
      `<figure class="tile">\n` +
        `        <div class="snapshot-frame"${tile.scrolls ? ' data-scrolls' : ''}>` +
        `<div class="snapshot" aria-hidden="true">${html.trim()}</div></div>\n` +
        `        <figcaption>${tile.caption}</figcaption>\n      </figure>`
    );
  }
  return `<div class="widget-tiles">\n      ${tiles.join('\n      ')}\n    </div>`;
}

let landing = await readFile(path.join(root, 'web/index.html'), 'utf8');
for (const [marker, rendered] of [
  ['<!-- build:clients -->', renderClients()],
  ['<!-- build:widget-tiles -->', await renderWidgetTiles()],
]) {
  if (!landing.includes(marker)) {
    throw new Error(`web/index.html is missing the ${marker} marker`);
  }
  landing = landing.replace(marker, () => rendered);
}
if (!landing.includes('<!-- build:jsonld -->')) {
  throw new Error('web/index.html is missing the <!-- build:jsonld --> marker');
}
landing = landing.replace('<!-- build:jsonld -->', () => renderJsonLd());

await writeFile(path.join(out, 'index.html'), openExternalLinksInNewTab(landing));
await writeFile(path.join(out, 'llms.txt'), renderLlmsTxt());
await writeFile(path.join(out, 'sitemap.xml'), renderSitemap());
await cp(path.join(root, 'web/robots.txt'), path.join(out, 'robots.txt'));
await cp(path.join(root, 'web/_headers'), path.join(out, '_headers'));
console.log(`built / with ${clients.length} client panels, and /llms.txt`);

await cp(path.join(root, 'web/fonts'), path.join(out, 'fonts'), { recursive: true });
// Brand assets: the SVG mark is the source of truth (web/brand/README.md
// documents how the raster sizes are rendered from it).
await mkdir(path.join(out, 'brand'), { recursive: true });
await cp(path.join(root, 'web/brand/mark.svg'), path.join(out, 'brand/mark.svg'));
await cp(path.join(root, 'web/icon-512.png'), path.join(out, 'icon-512.png'));
await cp(path.join(root, 'web/apple-touch-icon.png'), path.join(out, 'apple-touch-icon.png'));
await cp(path.join(root, 'web/og-image.png'), path.join(out, 'og-image.png'));
await cp(path.join(root, 'web/hero-slide.webp'), path.join(out, 'hero-slide.webp'));
for (const name of ['search', 'transcript', 'video-info', 'video-frame']) {
  await cp(
    path.join(root, `assets/widget-${name}.webp`),
    path.join(out, 'assets', `widget-${name}.webp`)
  );
}
console.log('copied landing page and assets');
