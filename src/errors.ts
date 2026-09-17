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
    'The platform answered this server with a bot detection check, so the video could not be read. This is about the server, not the video: do not retry now; other requests to this platform will likely fail the same way. Videos on other platforms still work.',
  rate_limited:
    'The platform is rate-limiting this server right now. Wait a few minutes, then retry once; until then most requests to this platform will fail the same way. Videos on other platforms are not affected.',
  timeout:
    'The server ran out of time on this request (the platform was slow or the job was too large). Retry once; if it times out again, do not retry.',
  extractor:
    'The server could not get a usable response from the platform for this video. This is on the server side: do not retry this request. If another video from the same platform fails the same way, stop and report that this platform is not working on this server right now; other platforms still work.',
  geo_blocked:
    'This video is not available in the region this server runs in. Do not retry; other requests for this video will fail the same way.',
  private:
    'This video is private, so the server cannot read it. Do not retry; other requests for this video will fail the same way.',
  age_restricted:
    'This video is age-restricted and this server cannot view it. Do not retry; other requests for this video will fail the same way.',
  unavailable:
    'This video is unavailable: it was removed or deleted, or the URL does not point to a single video (for example a channel, profile or search page). Do not retry the same URL; check the link.',
  unknown:
    'The server could not read this URL and could not determine why. Retry once; if it fails again, do not retry.',
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
