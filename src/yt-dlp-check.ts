import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { version as appVersion } from './version.js';
import { setYtDlpVersionInfo } from './metrics.js';

const execFileAsync = promisify(execFile);

const YT_DLP_VERSION_TIMEOUT_MS = 5000;
const GITHUB_API_TIMEOUT_MS = 10000;
const GITHUB_LATEST_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

export type YtDlpCheckLogger = {
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info?: (msg: string) => void;
};

function isExecFileException(error: unknown): error is ExecFileException {
  return error instanceof Error && (error as ExecFileException).code !== undefined;
}

/**
 * Parses a version string like "2026.2.4" or "2026.02.04" into [year, month, day].
 * Returns null if not parseable.
 */
const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)/;

export function parseYtDlpVersion(versionStr: string): [number, number, number] | null {
  const trimmed = versionStr.trim();
  const match = VERSION_REGEX.exec(trimmed);
  if (!match) return null;
  const y = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const d = Number.parseInt(match[3], 10);
  return [y, m, d];
}

/**
 * Compares two yt-dlp version tuples. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareYtDlpVersions(
  a: [number, number, number],
  b: [number, number, number]
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/**
 * Fetches the latest yt-dlp release tag from GitHub (e.g. "2026.02.04").
 * Returns null on network error or timeout.
 */
export async function fetchLatestYtDlpVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_LATEST_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `transcriptor-mcp/${appVersion}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return typeof data.tag_name === 'string' ? data.tag_name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export type YtDlpVersionCheck = {
  /** Installed version, or null when yt-dlp could not be run at all. */
  installed: string | null;
  /** Latest released version, or null when GitHub was unreachable or the check was skipped. */
  latest: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the installed yt-dlp version, compares it with the latest release and
 * publishes both to the metrics. Never exits: the caller decides what a missing
 * yt-dlp means. Safe to run repeatedly — the image freezes yt-dlp at build time,
 * so a long-lived server drifts behind and only a re-run notices.
 */
export async function checkYtDlpVersion(log?: YtDlpCheckLogger): Promise<YtDlpVersionCheck> {
  const out = log ?? {
    error: (msg: string) => console.error(msg),
    warn: (msg: string) => console.warn(msg),
    info: (msg: string) => console.warn(msg),
  };

  const skipVersionCheck = process.env.YT_DLP_SKIP_VERSION_CHECK === '1';

  let installedVersion: string;
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--version'], {
      timeout: YT_DLP_VERSION_TIMEOUT_MS,
      maxBuffer: 1024,
    });
    const firstLine = stdout.trim().split('\n')[0]?.trim() ?? '';
    const versionMatch = /\d+\.\d+\.\d+/.exec(firstLine);
    if (!versionMatch) {
      throw new Error('Could not parse yt-dlp version from output');
    }
    installedVersion = versionMatch[0];
  } catch (err) {
    const message =
      isExecFileException(err) && err.code === 'ENOENT'
        ? 'yt-dlp not found in system (not in PATH or not installed)'
        : 'yt-dlp failed to run or returned an error';
    out.error(message);
    return { installed: null, latest: null };
  }

  setYtDlpVersionInfo(installedVersion, false);
  if (skipVersionCheck) return { installed: installedVersion, latest: null };

  const latestTag = await fetchLatestYtDlpVersion();
  if (latestTag === null) return { installed: installedVersion, latest: null };

  const installed = parseYtDlpVersion(installedVersion);
  const latest = parseYtDlpVersion(latestTag);
  if (!installed || !latest) return { installed: installedVersion, latest: latestTag };

  const outdated = compareYtDlpVersions(installed, latest) < 0;
  setYtDlpVersionInfo(installedVersion, outdated);
  if (outdated) {
    out.warn(
      `yt-dlp version ${installedVersion} is older than latest ${latestTag}; consider upgrading`
    );
  }
  return { installed: installedVersion, latest: latestTag };
}

/**
 * Runs at startup: checks that yt-dlp is available and optionally compares
 * installed version with latest. Logs ERROR if yt-dlp is missing (and exits
 * unless YT_DLP_REQUIRED=0). Logs WARNING if installed version is older than latest.
 *
 * @param log - Optional logger; if omitted, uses console.error/warn/info.
 */
export async function checkYtDlpAtStartup(log?: YtDlpCheckLogger): Promise<YtDlpVersionCheck> {
  const result = await checkYtDlpVersion(log);
  if (result.installed === null && process.env.YT_DLP_REQUIRED !== '0') {
    process.exit(1);
  }
  return result;
}

/**
 * Re-runs the version check once a day so a server that has been up for weeks
 * still reports whether its yt-dlp has fallen behind. Unref'd: never holds the
 * process open.
 */
export function scheduleYtDlpVersionCheck(
  log?: YtDlpCheckLogger,
  intervalMs: number = DAY_MS
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void checkYtDlpVersion(log);
  }, intervalMs);
  timer.unref();
  return timer;
}
