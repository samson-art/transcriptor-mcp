/**
 * Base HTTP error with status code for use in setErrorHandler.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errorLabel: string
  ) {
    super(message);
    this.name = 'HttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 Bad Request – validation, invalid input */
export class ValidationError extends HttpError {
  constructor(message: string, errorLabel = 'Bad request') {
    super(400, message, errorLabel);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Optional details for 404 response (e.g. available subtitle languages) */
export type NotFoundDetails = {
  official?: string[];
  auto?: string[];
  /** The language the caller just asked for, so a hint can list it before the alphabet. */
  tried?: string;
};

/** 404 Not Found – resource or subtitles not found */
export class NotFoundError extends HttpError {
  readonly details?: NotFoundDetails;

  constructor(message: string, errorLabel = 'Not found', details?: NotFoundDetails) {
    super(404, message, errorLabel);
    this.name = 'NotFoundError';
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Every child-process slot is taken and the queue is full. Shedding load here
 * beats letting the box swap: yt-dlp, its JS runtime and ffmpeg are not cheap.
 */
export class ServerBusyError extends HttpError {
  constructor() {
    super(503, 'The server is busy, try again in a moment.', 'Server busy');
    this.name = 'ServerBusyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * What made a yt-dlp (or ffmpeg) run fail, as far as its output lets us tell.
 * `unknown` is the honest default: the classifier reads free-form stderr.
 */
export type YtDlpFailureReason =
  | 'bot_check'
  | 'rate_limited'
  | 'timeout'
  | 'extractor'
  | 'geo_blocked'
  | 'private'
  | 'age_restricted'
  | 'unavailable'
  | 'unknown';

/**
 * Classes that say something about our server or the platform's treatment of it,
 * not about the video. These are worth an alert; the rest are per-video facts.
 */
export const YT_DLP_INFRA_REASONS: ReadonlySet<YtDlpFailureReason> = new Set<YtDlpFailureReason>([
  'bot_check',
  'rate_limited',
  'timeout',
  'extractor',
]);

/**
 * One answer for "the server could not read this and cannot say why". Shared by the
 * yt-dlp `unknown` class and by the places that reach the same dead end without a
 * classified failure, so the caller cannot tell them apart — because they are not.
 */
export const UNKNOWN_FAILURE_MESSAGE =
  'The server could not read this URL and could not determine why. Retry once; if it fails again, do not retry.';

/**
 * The answer to an error nobody planned for, on MCP and REST alike. Its message can hold
 * a path, stderr or a command line (GET /changelogs once answered with the absolute path
 * of a missing file), so it stays in the log and this goes out instead.
 */
export const UNEXPECTED_ERROR_MESSAGE =
  'Internal server error (a fault in this server, not in your request). Retry once; if it fails again, do not retry — tell the user this cannot be completed right now.';

/**
 * Said by every tool that takes a video URL. Naming the platforms matters: the server
 * also rejects a supported platform's URL when the scheme is missing, and a caller with
 * "Invalid video URL." alone cannot tell which of the two it hit.
 */
export const INVALID_VIDEO_URL_MESSAGE =
  'Invalid video URL. Pass a full link starting with https:// to one video on YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion or Reddit, or a bare YouTube video ID. Short links and redirects may not be accepted — use the full page URL. Fix the argument and call again; if the link is from another site, it is not supported.';

/** Says the real rule, which is wider than a two-letter code: tracks are named `en_US`, `en-nP7-2PuUl7o`. */
export const INVALID_LANGUAGE_MESSAGE =
  'Invalid language code. Use a code such as "en", "ru" or "pt-BR" — letters, digits, hyphens and underscores, up to 32 characters. The list of available subtitles gives the exact codes a video has. Fix the argument and call again.';

/** User-facing text per reason. Never includes a command line, stderr or operator hints. */
const YT_DLP_MESSAGES: Record<YtDlpFailureReason, string> = {
  bot_check:
    'The platform answered this server with a bot detection check, so this request could not be completed. This is about the server, not about what was asked for: do not retry now; other requests to this platform will likely fail the same way. Other platforms still work.',
  rate_limited:
    'The platform is rate-limiting this server right now. Most requests to this platform keep failing while the limit lasts, and it can last hours: do not retry this request. Videos on other platforms are not affected.',
  timeout:
    'The server ran out of time on this request (the platform was slow or the job was too large). Retry once; if it times out again, do not retry.',
  extractor:
    'The server could not get a usable response from the platform for this request. This is on the server side: do not retry this request. If another request to the same platform fails the same way, stop and report that this platform is not working on this server right now; other platforms still work.',
  geo_blocked:
    'This video is not available where this server runs: the platform blocks it for the server’s region or address. Do not retry this request. On some platforms the title and description stay readable, on others the block covers the whole page.',
  private:
    'This video is private, so the server cannot read it. Do not retry; other requests for this video will fail the same way.',
  age_restricted:
    'This video is age-restricted and this server cannot view it. Do not retry this request. On some platforms the title and description stay readable, on others the restriction covers the whole page.',
  unavailable:
    'The content at this URL is unavailable: it was removed or deleted, or the URL is wrong or points to a page this server cannot read (for example a channel, profile or search page where one video is expected). Do not retry the same URL; check the link.',
  unknown: UNKNOWN_FAILURE_MESSAGE,
};

/**
 * A yt-dlp/ffmpeg failure with a known class. Infrastructure classes map to 502
 * (our problem or the platform's treatment of us), the rest to 404 (this video).
 * The full command and stderr stay in the log; only the message above goes out.
 */
export class YtDlpError extends HttpError {
  readonly reason: YtDlpFailureReason;

  constructor(reason: YtDlpFailureReason) {
    const infra = YT_DLP_INFRA_REASONS.has(reason);
    super(infra ? 502 : 404, YT_DLP_MESSAGES[reason], infra ? 'Upstream error' : 'Not found');
    this.name = 'YtDlpError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Status and caller text for an error that reaches an HTTP error handler. Our HttpError
 * texts are written for the caller, and Fastify's own 4xx (schema, JSON body, rate limit)
 * describe the request. Anything else answers the generic text.
 */
export function httpErrorAnswer(err: unknown): { statusCode: number; message: string } {
  if (err instanceof HttpError) return { statusCode: err.statusCode, message: err.message };
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (!(err instanceof Error) || typeof status !== 'number' || status < 400 || status > 599) {
    return { statusCode: 500, message: UNEXPECTED_ERROR_MESSAGE };
  }
  return { statusCode: status, message: status < 500 ? err.message : UNEXPECTED_ERROR_MESSAGE };
}

/**
 * Bounded label for an error, for a metric label or a Sentry tag. Keep it a
 * closed set: these values become time series.
 */
export function errorReason(err: unknown): string {
  if (err instanceof YtDlpError) return err.reason;
  if (err instanceof ServerBusyError) return 'busy';
  if (err instanceof NotFoundError) return 'not_found';
  if (err instanceof ValidationError) return 'validation';
  return 'unknown';
}
