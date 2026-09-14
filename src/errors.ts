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

/** User-facing text per reason. Never includes a command line, stderr or operator hints. */
const YT_DLP_MESSAGES: Record<YtDlpFailureReason, string> = {
  bot_check:
    'The video platform is asking for a sign-in check (bot detection), so this request could not be completed. Try again later.',
  rate_limited:
    'The video platform is rate-limiting requests right now. Try again in a few minutes.',
  timeout: 'The video platform did not respond in time. Try again.',
  extractor:
    'The video platform changed something and this video could not be read. Try again later.',
  geo_blocked: 'This video is not available from the server’s region.',
  private: 'This video is private.',
  age_restricted: 'This video is age-restricted and needs a signed-in account.',
  unavailable: 'This video is unavailable — removed, deleted, or the URL is wrong.',
  unknown: 'The video could not be fetched. Try again later.',
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
