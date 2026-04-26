import { spawn } from 'node:child_process';

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

/** When true, run `docker build` for images before starting containers. */
export function getShouldBuildDockerImages(): boolean {
  const skip = process.env.SMOKE_SKIP_BUILD;
  if (skip === '1' || skip === 'true' || skip === 'yes') {
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
