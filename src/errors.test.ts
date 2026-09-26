import {
  errorReason,
  HttpError,
  httpErrorAnswer,
  INVALID_LANGUAGE_MESSAGE,
  INVALID_VIDEO_URL_MESSAGE,
  NotFoundError,
  ServerBusyError,
  UNEXPECTED_ERROR_MESSAGE,
  UNKNOWN_FAILURE_MESSAGE,
  ValidationError,
  YtDlpError,
  type YtDlpFailureReason,
} from './errors.js';

const REASONS: YtDlpFailureReason[] = [
  'bot_check',
  'rate_limited',
  'timeout',
  'extractor',
  'geo_blocked',
  'private',
  'age_restricted',
  'unavailable',
  'unknown',
];

describe('errorReason', () => {
  // This is the function that decides a metric label and a Sentry tag, and it is read
  // through mocks everywhere else, so nothing pinned the mapping itself.
  it('names the class, not the message', () => {
    expect(errorReason(new YtDlpError('private'))).toBe('private');
    expect(errorReason(new ServerBusyError())).toBe('busy');
    expect(errorReason(new NotFoundError('x'))).toBe('not_found');
    expect(errorReason(new ValidationError('x'))).toBe('validation');
    expect(errorReason(new HttpError(418, 'x', 'teapot'))).toBe('unknown');
    expect(errorReason(new Error('x'))).toBe('unknown');
    expect(errorReason('not an error')).toBe('unknown');
  });
});

describe('httpErrorAnswer', () => {
  const PATH_ERROR = "EACCES: permission denied, stat '/app/static/x'";
  const withStatus = (statusCode: unknown, extra?: object) =>
    Object.assign(new Error(PATH_ERROR), { statusCode, ...extra });

  it("keeps the status and text of Fastify's own 4xx", () => {
    const err = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
    expect(httpErrorAnswer(err)).toEqual({ statusCode: 429, message: 'Rate limit exceeded' });
  });

  it.each([
    ['a 3xx', withStatus(302)],
    ['a 5xx', withStatus(500)],
    ['a 503', withStatus(503)],
    ['a status past 599', withStatus(600)],
    ['NaN', withStatus(NaN)],
    ['a fraction', withStatus(404.5)],
    ['a 4xx marked expose: false', withStatus(404, { expose: false })],
    // A thrown plain object has no message worth trusting, and "not in your request"
    // under a 400 would contradict itself.
    ['a plain object', { statusCode: 400, message: PATH_ERROR }],
  ])('answers 500 and the generic text for %s', (_name, err) => {
    expect(httpErrorAnswer(err)).toEqual({ statusCode: 500, message: UNEXPECTED_ERROR_MESSAGE });
  });
});

describe('caller-facing texts', () => {
  const texts = [
    ...REASONS.map((reason) => new YtDlpError(reason).message),
    UNKNOWN_FAILURE_MESSAGE,
    UNEXPECTED_ERROR_MESSAGE,
    INVALID_VIDEO_URL_MESSAGE,
    INVALID_LANGUAGE_MESSAGE,
  ];

  it.each(texts)('names no route, env var or internal component: %s', (text) => {
    // These strings go to the MCP caller and to REST verbatim. A route name is wrong on
    // one of the two surfaces by construction, and an env var is for the operator.
    expect(text).not.toMatch(/\bGET \/|\bPOST \//);
    expect(text).not.toMatch(/WHISPER_|YT_DLP_|CACHE_/);
    expect(text).not.toMatch(/yt-dlp|ffmpeg|Whisper|Redis/);
  });

  it('ends every reason with a step from the closed vocabulary', () => {
    // The vocabulary is small on purpose: a caller that reads an open-ended "try again
    // later" repeats a call that cannot succeed, which is what the prod report measured.
    for (const text of texts) {
      expect(text).toMatch(
        /do not retry|do not repeat the same call|retry once|fix the argument and call again/i
      );
    }
  });

  it('does not promise readable metadata it cannot deliver', () => {
    // True on YouTube, false on TikTok, where the same block hides the page as well —
    // the old wording sent the caller to another tool for nothing.
    for (const reason of ['geo_blocked', 'age_restricted'] as YtDlpFailureReason[]) {
      const message = new YtDlpError(reason).message;
      expect(message).not.toMatch(
        /details \(title, description, thumbnail\) may still be readable/
      );
    }
  });

  it('says which platforms a URL may come from', () => {
    // Five tools used to answer a bare "Invalid video URL.", which does not distinguish
    // an unsupported site from a supported one passed without a scheme.
    expect(INVALID_VIDEO_URL_MESSAGE).toContain('https://');
    expect(INVALID_VIDEO_URL_MESSAGE).toContain('TikTok');
    expect(INVALID_VIDEO_URL_MESSAGE).toContain('Fix the argument and call again');
  });

  it('describes language codes the way the server actually accepts them', () => {
    // The server hands out track names like `en_US` and `en-nP7-2PuUl7o`; a text that
    // promises "at most 10 characters, letters and hyphens" would forbid its own output.
    expect(INVALID_LANGUAGE_MESSAGE).toMatch(/underscores/);
    expect(INVALID_LANGUAGE_MESSAGE).toMatch(/\b32\b/);
    expect(INVALID_LANGUAGE_MESSAGE).not.toMatch(/\b10\b/);
  });
});

describe('YtDlpError', () => {
  it('answers the unknown class with the shared dead-end text', () => {
    expect(new YtDlpError('unknown').message).toBe(UNKNOWN_FAILURE_MESSAGE);
  });
});
