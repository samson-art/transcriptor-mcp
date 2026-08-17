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
const out = path.join(root, 'dist-site');

const REPO_URL = 'https://github.com/samson-art/transcriptor-mcp';

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
  await writeFile(path.join(out, page.dir, 'index.html'), html);
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
  if (client.kind === 'json') {
    parts.push(`<p class="cfg-file">Add to <code>${esc(client.file)}</code></p>`);
  }
  if (client.kind === 'command' || client.kind === 'json') {
    const text = client.kind === 'command' ? client.command : pretty(client.config);
    const label = client.kind === 'command' ? 'Copy command' : 'Copy config';
    parts.push(
      `<div class="pre-wrap">` +
        `<pre id="cfg-${client.id}">${esc(text)}</pre>` +
        `<button type="button" class="copy-btn" data-copy-target="#cfg-${client.id}" aria-live="polite">${label}</button>` +
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
      ${panels}
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

Endpoint: ${SERVER_URL} (Streamable HTTP; OAuth browser sign-in on first connection, no API keys).
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

// The landing page ships generated markup: web/index.html carries marker
// comments that this build replaces. Throw rather than emit a page with a
// silently missing section if a marker is ever renamed.
// The widget tiles are static snapshots of the real widgets rendered
// with real data (see web/widgets-demo/README.md).
const WIDGET_TILES = [
  { id: 'search', caption: '<code>search_videos</code> · a carousel of result cards' },
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
      `<figure class="tile">\n        <div class="snapshot" aria-hidden="true">${html.trim()}</div>\n        <figcaption>${tile.caption}</figcaption>\n      </figure>`
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
await writeFile(path.join(out, 'index.html'), landing);
await writeFile(path.join(out, 'llms.txt'), renderLlmsTxt());
console.log(`built / with ${clients.length} client panels, and /llms.txt`);

await cp(path.join(root, 'web/fonts'), path.join(out, 'fonts'), { recursive: true });
await cp(path.join(root, 'logo.webp'), path.join(out, 'logo.webp'));
await cp(path.join(root, 'web/icon-512.png'), path.join(out, 'icon-512.png'));
for (const name of ['search', 'transcript', 'video-info', 'video-frame']) {
  await cp(
    path.join(root, `assets/widget-${name}.webp`),
    path.join(out, 'assets', `widget-${name}.webp`)
  );
}
console.log('copied landing page and assets');
