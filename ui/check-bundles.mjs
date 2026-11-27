// Fails `npm run build` when an inline script of a widget bundle (dist/ui/*.html) is not valid
// JavaScript. Nothing else in the gate parses these files: ui/ is outside tsc and eslint, and Jest
// runs before the build. On 2026-11-27, vite 8.4.0 (rolldown 1.3.4) wrote
// `void 0a33d6d1af627f2faac2b25c05668ca08,import.meta.url` into all 4 bundles. No widget ran, and
// the gate stayed green.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = new URL('../dist/ui/', import.meta.url);
const names = readdirSync(dir).filter((name) => name.endsWith('.html'));
const failures = names.length ? [] : ['dist/ui: no widget bundles'];

for (const name of names) {
  const html = readFileSync(new URL(name, dir), 'utf8');
  // The browser ends an inline script at the first "</script", and so does this match.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script/gi)].filter(
    ([, attributes]) => !/(^|\s)src\s*=/i.test(attributes)
  );
  if (!scripts.length) failures.push(`dist/ui/${name}: no inline script`);
  for (const script of scripts) {
    const { status, stderr } = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: script[2],
      encoding: 'utf8',
    });
    if (status === 0) continue;
    // Node writes "[stdin]:<line>", the source line, a line with a caret under the error, then the
    // error. It shows the caret only in the first 1020 characters of a line. On 2026-11-27, the
    // failing line had 25165 characters, so the report names the line and not the column.
    const lines = stderr.split('\n');
    const start = script.index + script[0].indexOf('>') + 1;
    const line = html.slice(0, start).split('\n').length + Number(lines[0].split(':')[1]) - 1;
    const error = lines.slice(2).find((text) => /^\w*Error: /.test(text)) ?? 'does not parse';
    failures.push(`dist/ui/${name}:${line}: ${error}`);
  }
}

if (failures.length) {
  console.error(`Widget bundle check failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Widget bundles parse: ${names.join(', ')}`);
