/**
 * YouTube answers 429 on the caption endpoint for a whole day once it decides this
 * server asked too often: two such days in September 2026, 24 hours each. Every call
 * then paid for two doomed requests — the track's own URL, then yt-dlp — and the canary
 * kept probing on its own schedule, feeding the same quota. This holds a platform's
 * caption path back after a 429, so a limit costs one request per hold instead of
 * hundreds, and the caller hears "do not retry" instead of "wait a few minutes".
 *
 * Only subtitle downloads are held back. Metadata kept working through both days, and
 * a hold on it would break `get_video_info` for no reason.
 *
 * The state is process-local and deliberately not in Redis: a restart is a fine moment
 * to find out whether the platform still refuses.
 */
import { parseIntEnv } from './env.js';
import { YtDlpError } from './errors.js';
import { extractPlatformFromUrl } from './platform.js';

type Hold = { until: number; strikes: number };

const holds = new Map<string, Hold>();

const DEFAULT_HOLD_MS = 10 * 60 * 1000;
const MAX_HOLD_MS = 60 * 60 * 1000;

function baseHoldMs(): number {
  return parseIntEnv('SUBTITLES_RATE_LIMIT_HOLD_MS', DEFAULT_HOLD_MS);
}

/** Each strike doubles the wait — 10, 20, 40 minutes — and stops at an hour. */
function holdMs(strikes: number): number {
  const base = baseHoldMs();
  return Math.min(base * 2 ** (strikes - 1), Math.max(base, MAX_HOLD_MS));
}

/** Throws while this platform's caption path is held back. Call before asking it again. */
export function assertSubtitlesNotRateLimited(url: string): void {
  const hold = holds.get(extractPlatformFromUrl(url));
  if (hold && Date.now() < hold.until) throw new YtDlpError('rate_limited');
}

/** The platform answered 429: hold its caption path back, longer on every repeat. */
export function noteSubtitlesRateLimited(url: string): void {
  const platform = extractPlatformFromUrl(url);
  const now = Date.now();
  const prev = holds.get(platform);
  // Calls already in flight when the limit starts all report the same 429, and they must
  // not walk the wait up between them: only an attempt made AFTER a wait ran out counts as
  // a repeat. A gap longer than the base wait is a new limit, not the old one continuing.
  if (prev && now < prev.until) return;
  const strikes = prev !== undefined && now - prev.until <= baseHoldMs() ? prev.strikes + 1 : 1;
  holds.set(platform, { until: now + holdMs(strikes), strikes });
}

/** The platform answered with a track: it is not limiting this server any more. */
export function clearSubtitlesRateLimit(url: string): void {
  holds.delete(extractPlatformFromUrl(url));
}

/** Test helper: forgets every hold between cases. */
export function resetSubtitleRateLimitsForTests(): void {
  holds.clear();
}
