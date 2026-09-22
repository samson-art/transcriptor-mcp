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

  it('counts one strike for every call that reports the same limit', () => {
    // Four requests in flight when the platform starts refusing: one wait, not four.
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);
    noteSubtitlesRateLimited(WATCH);

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

  it('starts from the base wait again when a new limit comes long after the last', () => {
    noteSubtitlesRateLimited(WATCH);

    // A day later, with nothing in between: a new limit, not the old one continuing.
    jest.advanceTimersByTime(24 * 60 * MINUTE);
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).toThrow(YtDlpError);
    jest.advanceTimersByTime(10 * MINUTE);
    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
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

  it('is off when the base wait is zero', () => {
    process.env.SUBTITLES_RATE_LIMIT_HOLD_MS = '0';
    noteSubtitlesRateLimited(WATCH);

    expect(() => assertSubtitlesNotRateLimited(WATCH)).not.toThrow();
  });
});
