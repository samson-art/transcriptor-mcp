import { YtDlpError } from './errors.js';
import {
  assertSubtitlesNotRateLimited,
  clearSubtitlesRateLimit,
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';
import { renderPrometheus } from './metrics.js';

const WATCH = 'https://www.youtube.com/watch?v=x';
const SHORT = 'https://youtu.be/x';
const TIKTOK = 'https://www.tiktok.com/@a/video/1';
const VIMEO = 'https://vimeo.com/1';
const MINUTE = 60 * 1000;

/** The gauge the "banned" alert reads; -1 when the series does not exist. */
async function strikes(platform: string): Promise<number> {
  const line = (await renderPrometheus())
    .split('\n')
    .find((l) => l.startsWith(`subtitle_rate_limit_strikes{platform="${platform}"`));
  return line ? Number(line.split(' ').pop()) : -1;
}

describe('subtitle rate-limit hold', () => {
  beforeEach(() => {
    resetSubtitleRateLimitsForTests();
    delete process.env.SUBTITLES_RATE_LIMIT_HOLD_MS;
    jest.useFakeTimers().setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets a platform through until it answers 429', () => {
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('holds back every spelling of that platform, and no other platform', () => {
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(SHORT)).toThrow(YtDlpError);
    expect(() => assertSubtitlesNotRateLimited(TIKTOK)).not.toThrow();
  });

  it('tells the caller not to retry, in the words of the class', () => {
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(
      /^The platform is rate-limiting this server right now\..*do not retry this request\./
    );
  });

  it('counts one strike for every call that reports the same limit', async () => {
    // Four requests in flight when the platform starts refusing: one wait, not four — and
    // one strike on the gauge, or a single wave of refusals would read as a ban.
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    expect(await strikes('youtube')).toBe(1);

    jest.advanceTimersByTime(10 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('doubles the wait on every attempt that is refused again, and stops at an hour', () => {
    noteSubtitlesRateLimited(WATCH); // first: 10 minutes
    jest.advanceTimersByTime(10 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH); // second: 20 minutes
    jest.advanceTimersByTime(19 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    jest.advanceTimersByTime(MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH); // third: 40 minutes
    jest.advanceTimersByTime(40 * MINUTE);
    noteSubtitlesRateLimited(WATCH); // fourth: 80 minutes, capped at an hour
    jest.advanceTimersByTime(59 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    jest.advanceTimersByTime(MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('counts a refusal after the wait as the next strike, however long it took to come', async () => {
    noteSubtitlesRateLimited(WATCH);
    expect(await strikes('youtube')).toBe(1);

    // Traffic is sparse: the next request came twenty minutes after the hold, and the
    // platform refused it. Counting that as a first strike again (as 1.5.2–1.5.7 did for
    // any gap over the base wait) kept every 429 of 2026-09-24 looking like the first.
    jest.advanceTimersByTime(30 * MINUTE);
    noteSubtitlesRateLimited(WATCH);
    expect(await strikes('youtube')).toBe(2);

    jest.advanceTimersByTime(19 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    jest.advanceTimersByTime(MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    // Only a track resets the count, and it says so on the gauge.
    clearSubtitlesRateLimit(WATCH);
    expect(await strikes('youtube')).toBe(0);
  });

  it('forgets the limit once a download succeeds, and waits from the base again', () => {
    noteSubtitlesRateLimited(WATCH);
    jest.advanceTimersByTime(10 * MINUTE);
    noteSubtitlesRateLimited(WATCH); // second strike: 20 minutes
    clearSubtitlesRateLimit(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH);
    jest.advanceTimersByTime(10 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('takes the base wait from SUBTITLES_RATE_LIMIT_HOLD_MS, and never shortens it', () => {
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = String(MINUTE);
    noteSubtitlesRateLimited(WATCH);

    jest.advanceTimersByTime(59 * 1000);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    jest.advanceTimersByTime(1000);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    // A base longer than the hour cap is honoured: the cap never shortens a wait.
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = String(90 * MINUTE);
    noteSubtitlesRateLimited(TIKTOK);
    jest.advanceTimersByTime(89 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(TIKTOK)).toThrow(YtDlpError);
  });

  it('is off when the base wait is zero, and so is the strike count', async () => {
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = '0';
    noteSubtitlesRateLimited(VIMEO);
    noteSubtitlesRateLimited(VIMEO);

    expect(() => assertSubtitlesNotRateLimited(VIMEO)).not.toThrow();
    // With no wait there is no "after the wait": two refusals in flight are not a ban.
    expect(await strikes('vimeo')).toBe(-1);
  });
});
