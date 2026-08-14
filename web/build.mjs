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
    .replaceAll('{{eyebrow}}', () => page.source)
    .replace('{{content}}', () => content);
  await mkdir(path.join(out, page.dir), { recursive: true });
  await writeFile(path.join(out, page.dir, 'index.html'), html);
  console.log(`built /${page.dir} from ${page.source}`);
}

await cp(path.join(root, 'web/index.html'), path.join(out, 'index.html'));
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
