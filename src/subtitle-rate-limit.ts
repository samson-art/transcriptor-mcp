/**
 * YouTube answers 429 on the caption endpoint for a whole day once it decides this
 * server asked too often: two such days in September 2026, 24 hours each. Every call
 * then paid for a doomed request, and the canary kept probing on its own schedule,
 * feeding the same quota. This holds a platform's caption path back after a 429, so a
 * limit costs one request per hold instead of hundreds, and the caller hears "do not
 * retry" instead of "wait a few minutes". The strike count is a gauge: two means the
 * platform refused again after the hold with no track in between, which is what a ban
 * looks like.
 *
 * Only subtitle downloads are held back. Metadata kept working through both days, and
 * a hold on it would break `get_video_info` for no reason.
 *
 * The state is process-local and deliberately not in Redis: a restart is a fine moment
 * to find out whether the platform still refuses.
 */
import { parseIntEnv } from './env.js';
import { YtDlpError } from './errors.js';
import { setSubtitleRateLimitStrikes } from './metrics.js';
import { extractPlatformFromUrl } from './platform.js';

type Hold = { until: number; strikes: number };

const holds = new Map<string, Hold>();
const lastAnswered = new Map<string, number>();

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

/** Whether this platform's caption path is held back now. */
export function subtitlesRateLimited(url: string): boolean {
  const hold = holds.get(extractPlatformFromUrl(url));
  return !!hold && Date.now() < hold.until;
}

/** Throws while this platform's caption path is held back. Call before asking it again. */
export function assertSubtitlesNotRateLimited(url: string): void {
  if (subtitlesRateLimited(url)) throw new YtDlpError('rate_limited');
}

/** The platform answered 429: hold its caption path back, longer on every repeat. */
export function noteSubtitlesRateLimited(url: string): void {
  // Hold off means strike count off: without a wait, every 429 in flight would be a strike.
  if (baseHoldMs() <= 0) return;
  const platform = extractPlatformFromUrl(url);
  const now = Date.now();
  const prev = holds.get(platform);
  // Calls already in flight when the limit starts all report the same 429, and they must
  // not walk the wait up between them: only an attempt made AFTER a wait ran out counts as
  // a repeat — however long after. Nothing but a track resets the count (the canary asks
  // for one every CANARY_INTERVAL_MS while nothing else answers), so a repeat means the
  // platform refused again with no track in between. Counting only repeats within ten
  // minutes of the hold, as this did until 1.5.8, read every refusal of a sparse day as
  // the first one.
  if (prev && now < prev.until) return;
  const strikes = prev ? prev.strikes + 1 : 1;
  holds.set(platform, { until: now + holdMs(strikes), strikes });
  setSubtitleRateLimitStrikes(platform, strikes);
}

/** The platform answered with a track: it is not limiting this server any more. */
export function clearSubtitlesRateLimit(url: string): void {
  const platform = extractPlatformFromUrl(url);
  holds.delete(platform);
  lastAnswered.set(platform, Date.now());
  setSubtitleRateLimitStrikes(platform, 0);
}

/**
 * When this platform last handed over a track, or 0. A real call proves what a probe would.
 * The canary's own probe sets it too, so compare it with the stamp of that probe's track.
 */
export function lastSubtitlesAnswered(url: string): number {
  return lastAnswered.get(extractPlatformFromUrl(url)) ?? 0;
}

/** Test helper: forgets every hold between cases. */
export function resetSubtitleRateLimitsForTests(): void {
  holds.clear();
  lastAnswered.clear();
}
