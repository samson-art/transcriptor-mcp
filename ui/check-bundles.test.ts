// Runs ui/check-bundles.mjs on test bundles in a temp folder, the way `npm run build` runs it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(__dirname, 'check-bundles.mjs');
const apps = readdirSync(__dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(__dirname, entry.name, 'index.html')))
  .map((entry) => entry.name);
// The text that vite 8.4.0 and vite-plugin-singlefile 2.3.3 wrote into all 4 bundles on 2026-11-27.
const BROKEN = 'void 0a33d6d1af627f2faac2b25c05668ca08,import.meta.url';

// The script tag is on line 4, so script line N is page line N + 3.
function page(code: string, attributes = 'type="module" crossorigin', extra = ''): string {
  return `<!doctype html>\n<html>\n<head>\n${extra}<script ${attributes}>${code}</script>\n</head>\n</html>\n`;
}

let dir: string;
function write(app: string, html: string): void {
  writeFileSync(join(dir, `${app}.html`), html);
}
function run(env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundles-'));
  for (const app of apps) write(app, page('const a = import.meta.url;\nexport { a };'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ui/check-bundles.mjs', () => {
  it('checks one bundle for each app folder in ui/', () => {
    expect(apps).toEqual(['search', 'transcript', 'video-frame', 'video-info']);
  });

  it('passes valid bundles', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Widget bundles parse: search.html, transcript.html, video-frame.html, video-info.html'
    );
  });

  it('names the file and line of the 2026-11-27 syntax error', () => {
    write('transcript', page(`const a = 1;\n${BROKEN};`));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/transcript\.html:5: SyntaxError: Invalid or unexpected token/);
  });

  it('names every broken bundle', () => {
    for (const app of apps) write(app, page(BROKEN));
    const result = run();
    expect(result.status).toBe(1);
    for (const app of apps) expect(result.stderr).toContain(`${app}.html:4: SyntaxError`);
  });

  it('fails when a bundle is missing', () => {
    rmSync(join(dir, 'video-info.html'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/video-info\.html: missing/);
  });

  it('ignores other files in the folder', () => {
    writeFileSync(join(dir, 'old.html'), page(BROKEN));
    expect(run().status).toBe(0);
  });

  it('still fails when NODE_OPTIONS turns unhandled rejections into warnings', () => {
    write('search', page(BROKEN));
    const result = run({ ...process.env, NODE_OPTIONS: '--unhandled-rejections=warn' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/search\.html:4: SyntaxError: Invalid or unexpected token/);
  });

  it('still fails when a preload in NODE_OPTIONS swallows errors', () => {
    const preload = join(dir, 'swallow.cjs');
    writeFileSync(
      preload,
      "process.on('uncaughtException', () => {});\nprocess.on('unhandledRejection', () => {});\n"
    );
    write('search', page(BROKEN));
    const result = run({ ...process.env, NODE_OPTIONS: `--require "${preload}"` });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/search\.html:4: SyntaxError: Invalid or unexpected token/);
  });

  it('keeps the error text when the failing line is longer than 64 KiB', () => {
    write('search', page(`const s = "${'x'.repeat(200_000)}"; ${BROKEN};`));
    expect(run().stderr).toMatch(/search\.html:4: SyntaxError: Invalid or unexpected token/);
  });

  it('counts lines the way V8 does', () => {
    write('search', page(`const s = "a\u2028b";\n${BROKEN};`));
    expect(run().stderr).toMatch(/search\.html:5: SyntaxError/);
  });

  it('skips data blocks', () => {
    write(
      'search',
      page('export {};', 'type="module"', '<script type="application/json">{"a":1}</script>\n')
    );
    expect(run().status).toBe(0);
  });

  it('fails when a bundle has no module script', () => {
    write('search', page('{"a":1}', 'type="application/json"'));
    expect(run().stderr).toMatch(/search\.html: no module script/);
  });

  it('fails on an empty module script', () => {
    write('search', page(''));
    expect(run().stderr).toMatch(/search\.html:4: the module script is empty/);
  });

  it('fails on a module script that is not inlined', () => {
    write('search', page('', 'type="module" crossorigin src="./index-abc.js"'));
    expect(run().stderr).toMatch(
      /search\.html:4: the module script \.\/index-abc\.js is not inlined/
    );
  });

  it('reads src only from a real attribute, not from a quoted value', () => {
    write('search', page(BROKEN, 'type="module" data-note=" src=x"'));
    expect(run().stderr).toMatch(/search\.html:4: SyntaxError/);
  });

  it('fails on an import of a chunk that is not inlined', () => {
    write('search', page('import { a } from "./chunk-abc.js";\na();'));
    expect(run().stderr).toMatch(/search\.html:4: the script imports a chunk that is not inlined/);
  });

  it('fails on a root-relative chunk import and on new URL to a chunk', () => {
    write('search', page('import("/assets/chunk-abc.js");'));
    write('transcript', page('const u = new URL("./chunk-abc.js", import.meta.url);'));
    const result = run();
    expect(result.stderr).toMatch(/search\.html:4: the script imports a chunk that is not inlined/);
    expect(result.stderr).toMatch(
      /transcript\.html:4: the script imports a chunk that is not inlined/
    );
  });

  it('fails on a classic script', () => {
    write('search', page('export {};', 'type="module"', '<script nomodule>var a = 1;</script>\n'));
    write(
      'transcript',
      page('export {};', 'type="module"', '<script type="text/javascript">1</script>\n')
    );
    const result = run();
    expect(result.stderr).toMatch(
      /search\.html:4: a classic script, which this check does not parse/
    );
    expect(result.stderr).toMatch(/transcript\.html:4: a classic script/);
  });

  it('reads the type the way the browser does', () => {
    write('search', page(BROKEN, 'type=" Module "'));
    expect(run().stderr).toMatch(/search\.html:4: SyntaxError/);
  });

  it('fails on "<!--" in a script', () => {
    write('search', page('const s = 1;\nconst t = "<!--";'));
    expect(run().stderr).toMatch(/search\.html:5: "<!--" in a script/);
  });

  it('does not let a script tag in a comment hide the real script', () => {
    const comment = '<!-- <script type="module" src="./main.tsx"> -->\n';
    write('search', page(BROKEN, 'type="module"', comment));
    expect(run().stderr).toMatch(/search\.html:5: SyntaxError/);
  });
});
