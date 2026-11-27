// Fails `npm run build` when a widget bundle is missing or a browser would not run its code.
// Nothing else in the gate reads these files: ui/ is outside tsc and eslint, and Jest runs before
// the build. On 2026-11-27, vite 8.4.0 gave its preload marker a 32-hex suffix, and
// vite-plugin-singlefile 2.3.3 replaced only the part before the suffix with `void 0`. That wrote
// `void 0a33d6d1af627f2faac2b25c05668ca08,import.meta.url` into all 4 bundles. No widget ran, and
// the gate stayed green.
//
// Usage: node ui/check-bundles.mjs [folder]. The default folder is dist/ui.
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = fileURLToPath(new URL('./', import.meta.url));
const dir = process.argv[2] ?? join(uiDir, '../dist/ui');
// Each app folder ui/<app>/index.html builds to <app>.html, the file that the server reads. Other
// files in the folder, such as the output of a widget that no longer exists, do not count.
const apps = readdirSync(uiDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(uiDir, entry.name, 'index.html')))
  .map((entry) => entry.name);
const tmp = mkdtempSync(join(tmpdir(), 'check-bundles-'));
const failures = [];
try {
  for (const app of apps) checkBundle(join(dir, `${app}.html`));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`Widget bundle check failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Widget bundles parse: ${apps.map((app) => `${app}.html`).join(', ')}`);

function checkBundle(file) {
  const where = (offset) => `${show(file)}:${html.slice(0, offset).split('\n').length}`;
  if (!existsSync(file)) return failures.push(`${show(file)}: missing`);
  const html = readFileSync(file, 'utf8');
  // ponytail: a regex, not an HTML tokenizer. Comments are blanked (offsets kept), so a tag in a
  // comment cannot start a match. A script ends at the first "</script", but the browser also
  // needs a space, "/" or ">" after it. The browser also reads "<!--" in a script in a special
  // way, so a script with "<!--" fails. vite-plugin-singlefile 2.3.3 escapes both in inlined code.
  const markup = html.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  let modules = 0;
  for (const match of markup.matchAll(
    /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script/gi
  )) {
    const attributes = parseAttributes(match[1]);
    // Data blocks (JSON, import maps) are not code, and vite writes no classic scripts.
    if (attributes.type?.toLowerCase() !== 'module') continue;
    modules++;
    const start = match.index + '<script'.length + match[1].length + 1;
    const code = html.slice(start, start + match[2].length);
    const chunk = /\b(?:from|import)\s*\(?\s*["'`]\.\.?\//.exec(code);
    if ('src' in attributes) {
      failures.push(`${where(match.index)}: the module script ${attributes.src} is not inlined`);
    } else if (!code.trim()) {
      failures.push(`${where(start)}: the module script is empty`);
    } else if (code.includes('<!--')) {
      failures.push(`${where(start + code.indexOf('<!--'))}: "<!--" in a script`);
    } else if (chunk) {
      failures.push(
        `${where(start + chunk.index)}: the script imports a chunk that is not inlined`
      );
    } else {
      const error = parse(code);
      if (error) failures.push(`${where(start + error.offset)}: ${error.message}`);
    }
  }
  if (!modules) failures.push(`${show(file)}: no module script`);
}

// ponytail: the V8 of the Node that runs the build decides. That is Node 22 in CI and Docker. Node
// 24 accepts some syntax that Node 22 rejects, for example a duplicate named group in a regex.
function parse(code) {
  const stderrFile = join(tmp, 'stderr.txt');
  const fd = openSync(stderrFile, 'w');
  // Node repeats the whole failing line on stderr, and on a pipe it stops at 64 KiB. On 2026-11-27,
  // bundle lines were up to 149 KB long, so stderr goes to a file. For code from stdin, Node reports
  // a syntax error as an unhandled rejection. Then --unhandled-rejections=warn, or a preload that
  // handles the error, makes `node --check` exit 0. So the child gets no NODE_OPTIONS.
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: code,
    stdio: ['pipe', 'ignore', fd],
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  closeSync(fd);
  if (result.error || result.signal) {
    return {
      offset: 0,
      message: `the syntax check did not finish (${result.error?.code ?? result.signal})`,
    };
  }
  if (result.status === 0) return null;
  // Node writes "[stdin]:<line>", the source line, a caret line, then the error.
  const [first, , ...rest] = readFileSync(stderrFile, 'utf8').split('\n');
  const line = /^\[stdin\]:(\d+)$/.exec(first)?.[1];
  return {
    offset: line ? lineStart(code, Number(line)) : 0,
    message: rest.find((text) => /^\w*Error: /.test(text)) ?? 'not valid JavaScript',
  };
}

// V8 also counts "\r", U+2028 and U+2029 as line ends.
function lineStart(code, line) {
  const ends = /\r\n?|[\n\u2028\u2029]/g;
  for (let n = 1; n < line && ends.exec(code); n++);
  return ends.lastIndex;
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const [, name, ...values] of text.matchAll(pattern)) {
    attributes[name.toLowerCase()] = values.find((value) => value !== undefined) ?? '';
  }
  return attributes;
}

function show(file) {
  const path = relative(process.cwd(), file);
  return path.startsWith('..') || isAbsolute(path) ? file : path;
}
