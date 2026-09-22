import { YtDlpError } from './errors.js';
import {
  assertSubtitlesNotRateLimited,
  clearSubtitlesRateLimit,
  noteSubtitlesRateLimited,
  resetSubtitleRateLimitsForTests,
} from './subtitle-rate-limit.js';

const WATCH = 'https://www.youtube.com/watch?v=x';
const SHORT = 'https://youtu.be/x';
const TIKTOK = 'https://www.tiktok.com/@a/video/1';
const MINUTE = 60 * 1000;

function thrownBy(fn: () => void): YtDlpError {
  try {
    fn();
  } catch (err) {
    return err as YtDlpError;
  }
  throw new Error('expected a rate limit');
}

describe('subtitle rate-limit hold', () => {
  let now = 0;
  let dateSpy: jest.SpyInstance;

  beforeEach(() => {
    resetSubtitleRateLimitsForTests();
    delete process.env.SUBTITLES_RATE_LIMIT_HOLD_MS;
    now = 1_700_000_000_000;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    dateSpy.mockRestore();
    resetSubtitleRateLimitsForTests();
    delete process.env.SUBTITLES_RATE_LIMIT_HOLD_MS;
  });

  it('lets a platform through until it answers 429', () => {
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('holds back every spelling of that platform, and no other platform', () => {
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(SHORT)).toThrow(YtDlpError);
    expect(() => assertSubtitlesNotRateLimited(TIKTOK)).not.toThrow();
  });

  it('tells the caller how long the limit has been on and how long not to retry', () => {
    noteSubtitlesRateLimited(WATCH);
    now += 4 * MINUTE;

    const err = thrownBy(() => assertSubtitlesNotRateLimited(WATCH));

    expect(err.reason).toBe('rate_limited');
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('refusing this server for the last 4 minutes');
    expect(err.message).toContain('will not ask it again for 6 minutes');
    // The fixed sentence owns the one next step; the detail only adds facts.
    expect(err.message).toMatch(/^The platform is rate-limiting this server right now\./);
    expect(err.message).toContain('do not retry this request');
  });

  it('counts a limit that has lasted hours in hours, not in minutes', () => {
    noteSubtitlesRateLimited(WATCH);
    for (const wait of [10, 20, 40, 60, 60]) {
      now += wait * MINUTE;
      noteSubtitlesRateLimited(WATCH);
    }
    now += MINUTE;

    expect(thrownBy(() => assertSubtitlesNotRateLimited(WATCH)).message).toContain(
      'for the last 3 hours'
    );
  });

  it('counts one strike for every call that reports the same limit', () => {
    // Four requests in flight when the platform starts refusing: one wait, not four.
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);

    now += 10 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('doubles the wait on every attempt that is refused again, and stops at an hour', () => {
    noteSubtitlesRateLimited(WATCH); // first: 10 minutes
    now += 10 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH); // second: 20 minutes
    now += 19 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    now += MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH); // third: 40 minutes
    now += 40 * MINUTE;
    noteSubtitlesRateLimited(WATCH); // fourth: 80 minutes, capped at an hour
    now += 59 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    now += MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('starts from the base wait again when a new limit comes long after the last', () => {
    noteSubtitlesRateLimited(WATCH);

    // A day later, with nothing in between: a new limit, not the old one continuing.
    now += 24 * 60 * MINUTE;
    noteSubtitlesRateLimited(WATCH);

    expect(thrownBy(() => assertSubtitlesNotRateLimited(WATCH)).message).toContain(
      'for the last 1 minutes'
    );
    now += 10 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('forgets the limit once a download succeeds, and waits from the base again', () => {
    noteSubtitlesRateLimited(WATCH);
    now += 10 * MINUTE;
    noteSubtitlesRateLimited(WATCH); // second strike: 20 minutes
    clearSubtitlesRateLimit(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    noteSubtitlesRateLimited(WATCH);
    now += 10 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });

  it('takes the base wait from SUBTITLES_RATE_LIMIT_HOLD_MS, and never shortens it', () => {
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = String(MINUTE);
    noteSubtitlesRateLimited(WATCH);

    now += 59 * 1000;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    now += 1000;
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();

    // A base longer than the hour cap is honoured: the cap never shortens a wait.
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = String(90 * MINUTE);
    noteSubtitlesRateLimited(TIKTOK);
    now += 89 * MINUTE;
    expect(() => assertSubtitlesNotRateLimited(TIKTOK)).toThrow(YtDlpError);
  });

  it('is off when the base wait is zero', () => {
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = '0';
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });
});
