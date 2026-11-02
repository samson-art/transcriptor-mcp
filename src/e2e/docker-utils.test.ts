import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { readFirstLineAsJson, runCommandWithStdin } from './docker-utils.js';

// The answer of the stdio server to `initialize`, as the SDK writes it: one JSON line.
const RESPONSE =
  '{"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"transcriptor-mcp","version":"1.5.21"}},"jsonrpc":"2.0","id":1}';
// What `npm run start:mcp` of 1.5.21 printed to stdout before the server started (#81).
const NPM_BANNER =
  '\n> transcriptor-mcp@1.5.21 start:mcp\n> node --import ./dist/instrument.js dist/mcp.js\n\n';

describe('readFirstLineAsJson', () => {
  it.each([
    ['the npm script banner', NPM_BANNER],
    ['a blank line', '\n'],
    // A reader that skips only lines that are not blank passes the two rows above.
    ['a line that is not blank and not JSON', 'stray log line\n'],
  ])('fails when %s comes before the first message', async (_name, before) => {
    await expect(readFirstLineAsJson(Readable.from([before + RESPONSE + '\n']))).rejects.toThrow(
      'The first stdout line is not JSON'
    );
  });

  it('resolves with the first line when it is the message', async () => {
    await expect(readFirstLineAsJson(Readable.from([RESPONSE + '\n']))).resolves.toEqual(
      JSON.parse(RESPONSE)
    );
  });

  it('fails when stdout closes before the first line', async () => {
    await expect(readFirstLineAsJson(Readable.from([]))).rejects.toThrow(
      'closed stdout before its first line'
    );
  });
});

// A local node child stands in for `docker run`, so these tests use no network and no docker.
describe('runCommandWithStdin', () => {
  const runScript = (script: string, timeoutMs = 10000) =>
    runCommandWithStdin(process.execPath, ['-e', script], 'ping\n', timeoutMs);
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('fails when the child writes the npm script banner before the answer', async () => {
    const script = `process.stdout.write(${JSON.stringify(NPM_BANNER + RESPONSE + '\n')}); setInterval(() => {}, 1000);`;
    await expect(runScript(script)).rejects.toThrow('The first stdout line is not JSON');
  });

  it('sends stdin, resolves with the first line and stops the child', async () => {
    // The child answers only after it reads stdin, and then it runs until something stops it.
    const script = `process.stdin.once('data', (d) => { console.log(JSON.stringify({ got: String(d).trim(), pid: process.pid })); setInterval(() => {}, 1000); });`;
    const data = (await runScript(script)) as { got: string; pid: number };

    expect(data.got).toBe('ping');
    for (let i = 0; i < 100 && isRunning(data.pid); i++) await sleep(50);
    expect(isRunning(data.pid)).toBe(false);
  });

  it('fails when the child writes nothing before the timeout', async () => {
    await expect(runScript('setInterval(() => {}, 1000);', 300)).rejects.toThrow(
      'Command timed out after 300ms'
    );
  });

  it('fails when the command cannot start', async () => {
    await expect(
      runCommandWithStdin('/nonexistent/transcriptor-smoke', [], 'ping\n', 10000)
    ).rejects.toThrow('ENOENT');
  });

  it('fails when the child closes stdin before it reads the input', async () => {
    // The child keeps stdout open, so only the failed write can end the call. The input is larger
    // than the pipe buffer, so the write cannot finish before the child closes stdin.
    const script = "require('node:fs').closeSync(0); setInterval(() => {}, 1000);";
    await expect(
      runCommandWithStdin(process.execPath, ['-e', script], 'x'.repeat(1 << 22), 10000)
    ).rejects.toThrow(/EPIPE|ECONNRESET/);
  });
});

// PR CI builds no image and runs no make target. Without these tests, only the MCP smoke at the tag
// push sees the image setting, and nothing sees the `@`.
describe('stdout of the stdio server (#81)', () => {
  it('sets the silent npm log level in the mcp stage, after npm ci', () => {
    const [, afterMcp] = readFileSync('Dockerfile', 'utf-8').split(/^FROM base AS mcp$/m);
    const lines = afterMcp.split('\n');
    // Match the instruction: the comment above the ENV also names `npm ci`.
    const npmCi = lines.findIndex((line) => /^RUN .*npm ci/.test(line));

    expect(lines).toContain('ENV NPM_CONFIG_LOGLEVEL=silent');
    expect(npmCi).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('ENV NPM_CONFIG_LOGLEVEL=silent')).toBeGreaterThan(npmCi);
  });

  it('keeps make from writing the recipe of docker-run-mcp-stdio to stdout', () => {
    const lines = readFileSync('Makefile', 'utf-8').split('\n');
    const target = lines.findIndex((line) => line.startsWith('docker-run-mcp-stdio:'));

    expect(lines[target + 1]).toMatch(/^\t@docker run /);
  });
});
