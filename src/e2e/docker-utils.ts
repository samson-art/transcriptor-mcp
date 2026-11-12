import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { isFlagSet } from './smoke-env.js';

export type RunCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function runCommand(
  command: string,
  args: string[],
  options: { stdio?: 'ignore' | 'inherit' } = {}
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

/**
 * Reads the first line that an MCP stdio server writes to stdout, as JSON. The stdio transport
 * allows only MCP messages on stdout, so a first line that is not JSON fails, a blank line too.
 * This reader does not check the JSON-RPC shape: `checkMcpStdio` in `mcp-smoke.ts` does that. On
 * 2026-10-07, `npm run start:mcp` of 1.5.21 wrote the npm script banner, which starts with a blank
 * line, before the first message. A reader that skips lines that are not JSON lets the banner pass
 * (#81).
 */
export async function readFirstLineAsJson(stdout: Readable): Promise<unknown> {
  for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `The first stdout line is not JSON: ${JSON.stringify(line.slice(0, 200))}. In stdio mode, stdout must carry only MCP messages.`
      );
    }
  }
  throw new Error('The MCP stdio server closed stdout before its first line');
}

/** Starts a stdio server, sends `stdinInput` and returns its first stdout line, as JSON. */
export function runCommandWithStdin(
  command: string,
  args: string[],
  stdinInput: string,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // No "settled" flag: a Promise ignores a second settle, and a repeated clearTimeout or kill
    // does nothing.
    const settle = (finish: () => void, signal?: NodeJS.Signals) => {
      clearTimeout(timeout);
      child.kill(signal);
      finish();
    };
    const fail = (err: Error) => settle(() => reject(err));
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), 'SIGKILL');
    }, timeoutMs);

    // ponytail: the first stdout line must be the answer, so a valid MCP notification in front of
    // it fails the smoke with "missing result". If a server or SDK writes one (#86), wait for the
    // first `result` or `error` line, and make every line before it parse as JSON.
    readFirstLineAsJson(child.stdout).then((data) => settle(() => resolve(data)), fail);

    child.on('error', fail);
    child.stderr.on('data', (data: Buffer | string) => {
      process.stderr.write(data);
    });
    child.stdin.on('error', fail);
    child.stdin.end(stdinInput);
  });
}

/** When true, run `docker build` for images before starting containers. */
export function getShouldBuildDockerImages(): boolean {
  if (isFlagSet('SMOKE_SKIP_BUILD')) {
    return false;
  }
  const build = process.env.SMOKE_BUILD;
  if (build === '0' || build === 'false' || build === 'no') {
    return false;
  }
  return true;
}

export function getDockerBuildContext(): string {
  const fromEnv = process.env.SMOKE_DOCKER_CONTEXT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
}

export function getDockerfileRelativePath(): string {
  const fromEnv = process.env.SMOKE_DOCKERFILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'Dockerfile';
}

export async function buildDockerImage(
  contextDir: string,
  dockerfileRel: string,
  target: 'api' | 'mcp',
  imageRef: string
): Promise<void> {
  const args = ['build', '-t', imageRef, '-f', dockerfileRel, '--target', target, contextDir];
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${['docker', ...args].join(' ')}`);
  const result = await runCommand('docker', args);
  if (result.code !== 0) {
    throw new Error(
      `docker build failed for --target ${target} (exit code ${result.code}, signal ${result.signal})`
    );
  }
}

export async function buildDockerImagesIfNeeded(
  image: string,
  mcpImage: string,
  skipMcp: boolean
): Promise<void> {
  if (!getShouldBuildDockerImages()) {
    return;
  }
  const contextDir = getDockerBuildContext();
  const dockerfileRel = getDockerfileRelativePath();
  await buildDockerImage(contextDir, dockerfileRel, 'api', image);
  if (!skipMcp) {
    await buildDockerImage(contextDir, dockerfileRel, 'mcp', mcpImage);
  }
}
