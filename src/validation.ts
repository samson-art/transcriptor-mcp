import { FastifyBaseLogger } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import {
  INVALID_LANGUAGE_MESSAGE,
  INVALID_VIDEO_URL_MESSAGE,
  NotFoundError,
  UNKNOWN_FAILURE_MESSAGE,
  ValidationError,
  YtDlpError,
} from './errors.js';
import {
  extractYouTubeVideoId,
  downloadSubtitles,
  fetchVideoInfo,
  fetchVideoChapters,
  fetchYtDlpJson,
  captureVideoFrame,
  getImageWidth,
  mapVideoInfo,
  resolveSubtitleFormat,
  type SubtitleFormat,
  type YtDlpVideoInfo,
  type VideoFrameFormat,
} from './youtube.js';
import { extractPlatformFromUrl } from './platform.js';
import { assertSubtitlesNotRateLimited } from './subtitle-rate-limit.js';
import { getWhisperConfig } from './whisper.js';
import { parseIntEnv } from './env.js';
import { startOrReuseWhisperJob } from './whisper-jobs.js';
import { getCacheConfig, get, set, buildCacheKey } from './cache.js';
import {
  recordCacheHit,
  recordCacheMiss,
  recordSubtitlesFailure,
  recordUntriedTracks,
} from './metrics.js';

/** Allowed video hostnames for top-10 platforms (exact or suffix match). */
export const ALLOWED_VIDEO_DOMAINS = [
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'm.youtube.com',
  'x.com',
  'twitter.com',
  'www.twitter.com',
  'instagram.com',
  'www.instagram.com',
  'tiktok.com',
  'www.tiktok.com',
  'vm.tiktok.com',
  'twitch.tv',
  'www.twitch.tv',
  'vimeo.com',
  'www.vimeo.com',
  'facebook.com',
  'www.facebook.com',
  'fb.watch',
  'fb.com',
  'm.facebook.com',
  'bilibili.com',
  'www.bilibili.com',
  'vk.com',
  'vk.ru',
  'www.vk.com',
  'vkvideo.ru',
  'www.vkvideo.ru',
  'dailymotion.com',
  'www.dailymotion.com',
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'v.redd.it',
] as const;

/**
 * A subtitle track name as yt-dlp keys it: a language code (`en`, `zh-Hans`), but also
 * Facebook's locale (`en_US`), a YouTube named track's vssId (`en-nP7-2PuUl7o`), Vimeo's
 * `en-x-autogen`. yt-dlp reads `--sub-langs` as comma-separated regexes matched whole, so
 * no `,`, `.` or other metacharacter, no leading `-` (it means "exclude"), and not `all`.
 */
export const LANG_PATTERN = '^(?!all$)[A-Za-z0-9][A-Za-z0-9_-]{0,31}$';
const LANG_RE = new RegExp(LANG_PATTERN);

// TypeBox schema for subtitle request.
// When both type and lang are omitted, auto-discovery is used (official → auto with -orig for YouTube → auto → Whisper).
export const GetSubtitlesRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'Video URL from a supported platform (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or YouTube video ID',
  }),
  type: Type.Optional(
    Type.Union([Type.Literal('official'), Type.Literal('auto')], {
      description:
        'Type of subtitles: official or auto-generated. Omit with lang for auto-discovery.',
    })
  ),
  lang: Type.Optional(
    Type.String({
      pattern: LANG_PATTERN,
      description:
        'Language code or track name as the available-subtitles list gives it (e.g., en, ru, en-US, en_US). Omit with type for auto-discovery.',
    })
  ),
  format: Type.Optional(
    Type.Union(
      [Type.Literal('srt'), Type.Literal('vtt'), Type.Literal('ass'), Type.Literal('lrc')],
      {
        description: 'Subtitle format: srt, vtt, ass, lrc. Default from YT_DLP_SUB_FORMAT or srt.',
      }
    )
  ),
});

export type GetSubtitlesRequest = Static<typeof GetSubtitlesRequestSchema>;

/** True when both type and lang are omitted — triggers auto-discovery flow. */
export function shouldAutoDiscoverSubtitles(request: GetSubtitlesRequest): boolean {
  return request.type === undefined && request.lang === undefined;
}

// Schema for request to get available subtitles
export const GetAvailableSubtitlesRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'Video URL from a supported platform (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or YouTube video ID',
  }),
});

export type GetAvailableSubtitlesRequest = Static<typeof GetAvailableSubtitlesRequestSchema>;

// Schema for request to get video info or chapters
export const GetVideoInfoRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'Video URL from a supported platform (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or YouTube video ID',
  }),
});

export type GetVideoInfoRequest = Static<typeof GetVideoInfoRequestSchema>;

/**
 * Validates and sanitizes YouTube URL
 * @param url - URL to validate
 * @returns true if URL is valid, false otherwise
 */
export function isValidYouTubeUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  // Check that URL starts with http:// or https://
  if (!/^https?:\/\//.test(url)) {
    return false;
  }

  // Allow only valid YouTube domains
  const validDomains = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'];

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check that domain is valid
    const isValidDomain = validDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!isValidDomain) {
      return false;
    }

    // Check for video ID in URL
    return extractYouTubeVideoId(url) !== null;
  } catch {
    return false;
  }
}

/**
 * Checks if the input is a supported video URL or a bare YouTube-like ID.
 * For strings without a scheme, treats as YouTube ID only if it looks like one (safe chars, length).
 */
export function isValidSupportedUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const urlObj = new URL(trimmed);
      const hostname = urlObj.hostname.toLowerCase();
      return ALLOWED_VIDEO_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    } catch {
      return false;
    }
  }
  // Bare YouTube ID: alphanumeric, hyphen, underscore; length 1–50
  return /^[a-zA-Z0-9_-]{1,50}$/.test(trimmed);
}

/**
 * Normalizes input to a single video URL.
 * If input has no scheme and looks like a YouTube ID, returns YouTube watch URL.
 * Otherwise parses as URL and returns it if domain is in allowlist, else null.
 */
export function normalizeVideoInput(urlOrId: string): string | null {
  if (!urlOrId || typeof urlOrId !== 'string') {
    return null;
  }
  const trimmed = urlOrId.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    if (!isValidSupportedUrl(trimmed)) {
      return null;
    }
    try {
      const u = new URL(trimmed);
      return u.href;
    } catch {
      return null;
    }
  }
  const asId = sanitizeVideoId(trimmed);
  if (!asId) {
    return null;
  }
  return `https://www.youtube.com/watch?v=${asId}`;
}

/**
 * Validates video URL or YouTube ID and returns normalized URL.
 * @throws ValidationError on validation failure
 */
export function validateVideoRequest(url: string): { url: string } {
  const normalized = normalizeVideoInput(url);
  if (!normalized) {
    throw new ValidationError(INVALID_VIDEO_URL_MESSAGE, 'Invalid video URL');
  }
  return { url: normalized };
}

/**
 * Sanitizes video ID - allows only safe characters
 * @param videoId - video ID to sanitize
 * @returns sanitized video ID or null if contains invalid characters
 */
export function sanitizeVideoId(videoId: string): string | null {
  if (!videoId || typeof videoId !== 'string') {
    return null;
  }

  // YouTube video ID contains only letters, numbers, hyphens and underscores
  // Length is usually 11 characters, but can vary
  const sanitized = videoId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
    return null;
  }

  // Limit length for security
  if (sanitized.length > 50) {
    return null;
  }

  return sanitized;
}

/**
 * Sanitizes a language code or track name (see LANG_PATTERN)
 * @param lang - language code to sanitize
 * @returns trimmed language code, or null if it is not a safe track name
 */
export function sanitizeLang(lang: string): string | null {
  if (!lang || typeof lang !== 'string') {
    return null;
  }

  const sanitized = lang.trim();
  return LANG_RE.test(sanitized) ? sanitized : null;
}

/**
 * Validates YouTube URL and returns sanitized video ID.
 * @param url - YouTube video URL from request
 * @returns object with videoId
 * @throws ValidationError on validation failure
 */
export function validateYouTubeRequest(url: string): { videoId: string } {
  if (!isValidYouTubeUrl(url)) {
    throw new ValidationError('Please provide a valid YouTube video URL', 'Invalid YouTube URL');
  }

  const extractedVideoId = extractYouTubeVideoId(url);
  if (!extractedVideoId) {
    throw new ValidationError(
      'Could not extract video ID from the provided URL',
      'Invalid YouTube URL'
    );
  }

  const videoId = sanitizeVideoId(extractedVideoId);
  if (!videoId) {
    throw new ValidationError('Video ID contains invalid characters', 'Invalid video ID');
  }

  return { videoId };
}

/**
 * Best track first. The lists arrive sorted alphabetically, which is why a video listing
 * `ar, de, en` used to spend two caption requests before reaching the one anybody wanted.
 */
export function preferredTrackOrder(langs: string[], promote?: string | null): string[] {
  const base = (lang: string): string => lang.split('-')[0].toLowerCase();
  const first = promote ? base(promote) : undefined;
  const rank = (lang: string): number => {
    if (lang.endsWith('-orig')) return 0; // YouTube's track in the audio's own language
    if (first && base(lang) === first) return 1;
    if (base(lang) === 'en') return 2;
    return 3;
  };
  return [...langs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * How many tracks auto-discovery may ask the platform for. It used to be three official
 * plus three auto, so one call could spend six requests against a caption budget that a
 * day-long 429 is measured in. One of each covers a video whose official track is broken
 * and one whose auto track is missing; past that it is guessing with someone else's quota,
 * and `subtitle_tracks_untried_total` counts what the guessing would have covered.
 */
const AUTO_DISCOVERY_ATTEMPTS = 2;

/**
 * Auto-discovery: try official → auto (-orig first for YouTube) → all auto → Whisper.
 * @returns subtitle result or null if all attempts failed
 */
/** When set, a late Whisper result after {@link getWhisperConfig}.timeout is still written to Redis. */
type WhisperRedisCacheInfo = { key: string; ttl: number };

async function downloadWithAutoDiscover(
  url: string,
  format?: SubtitleFormat,
  logger?: FastifyBaseLogger,
  whisperRedisCache?: WhisperRedisCacheInfo
): Promise<{
  videoId: string;
  type: 'official' | 'auto';
  lang: string;
  subtitlesContent: string;
  source: string;
} | null> {
  const available = await loadAvailableSubtitles(url, logger);
  const { videoId, official, auto, data } = available;
  const platform = extractPlatformFromUrl(url);

  const officialRanked = preferredTrackOrder(official, data?.language);
  const autoRanked = preferredTrackOrder(auto, data?.language);
  const attempts: Array<{ type: 'official' | 'auto'; lang: string }> = [];
  for (let i = 0; attempts.length < AUTO_DISCOVERY_ATTEMPTS; i += 1) {
    if (!officialRanked[i] && !autoRanked[i]) break;
    if (officialRanked[i]) attempts.push({ type: 'official', lang: officialRanked[i] });
    if (attempts.length < AUTO_DISCOVERY_ATTEMPTS && autoRanked[i]) {
      attempts.push({ type: 'auto', lang: autoRanked[i] });
    }
  }

  for (const { type, lang } of attempts) {
    const content = await downloadSubtitles(url, type, lang, format, logger);
    if (content && content.trim().length > 0) {
      return { videoId, type, lang, subtitlesContent: content, source: platform };
    }
  }

  // Everything listed that we chose not to ask for: the price of the cap, counted in tracks
  // that might have answered. Only when the ladder came back empty, because that is the one
  // case where the untried ones could have changed the answer.
  const untried = officialRanked.length + autoRanked.length - attempts.length;
  if (untried > 0) {
    recordUntriedTracks(platform, untried);
    logger?.info(
      { listed: officialRanked.length + autoRanked.length, tried: attempts.length, untried },
      'Auto-discovery gave up with tracks left untried'
    );
  }

  // 3. Whisper fallback (background job: survives per-request WHISPER_TIMEOUT for cache)
  const whisperConfig = getWhisperConfig();
  if (whisperConfig.mode !== 'off') {
    logger?.info('Trying Whisper fallback for auto-discovery');
    const job = startOrReuseWhisperJob(url, '', 'srt', logger);
    const outcome = await raceWhisperJob(job, whisperConfig.timeout);

    let content: string | null = null;
    if (outcome.kind === 'timeout') {
      if (whisperRedisCache) {
        void job.then((text) => {
          if (!text?.trim()) {
            return;
          }
          const payload = {
            videoId,
            type: 'auto' as const,
            lang: '',
            subtitlesContent: text,
            source: 'whisper',
          };
          void set(whisperRedisCache.key, JSON.stringify(payload), whisperRedisCache.ttl);
        });
      }
      content = null;
    } else {
      content = outcome.content;
    }

    if (content && content.trim().length > 0) {
      return {
        videoId,
        type: 'auto',
        lang: '',
        subtitlesContent: content,
        source: 'whisper',
      };
    }
  }

  return null;
}

type AvailableSubtitles = { videoId: string; official: string[]; auto: string[] };
type VideoJson = {
  data: YtDlpVideoInfo;
  avail: AvailableSubtitles;
  info: { videoId: string; info: Awaited<ReturnType<typeof fetchVideoInfo>> };
  chapters: { videoId: string; chapters: Awaited<ReturnType<typeof fetchVideoChapters>> };
};

/** One in-flight yt-dlp JSON run per URL; the widgets ask three tools about one video at once. */
const videoJsonInFlight = new Map<string, Promise<VideoJson | null>>();

function sortedTrackLangs(tracks?: Record<string, unknown>): string[] {
  return tracks ? Object.keys(tracks).sort((a, b) => a.localeCompare(b)) : [];
}

/**
 * One yt-dlp run answers info, the track list and chapters, and hands the JSON to the
 * caller for the tracks' own URLs. All three cache entries are filled, so the next tool
 * asking about this video is a cache hit.
 */
async function buildVideoJson(url: string, logger?: FastifyBaseLogger): Promise<VideoJson | null> {
  const data = await fetchYtDlpJson(url, logger);
  if (!data) return null;
  const videoId = data.id ?? extractYouTubeVideoId(url) ?? 'unknown';
  const result: VideoJson = {
    data,
    avail: {
      videoId,
      official: sortedTrackLangs(data.subtitles),
      auto: sortedTrackLangs(data.automatic_captions),
    },
    info: { videoId, info: mapVideoInfo(data) },
    chapters: { videoId, chapters: await fetchVideoChapters(url, logger, data) },
  };
  const ttl = getCacheConfig().ttlMetadataSeconds;
  await Promise.all([
    set(buildCacheKey('avail', url), JSON.stringify(result.avail), ttl),
    set(buildCacheKey('info', url), JSON.stringify(result.info), ttl),
    set(buildCacheKey('chapters', url), JSON.stringify(result.chapters), ttl),
  ]);
  return result;
}

async function loadVideoJson(url: string, logger?: FastifyBaseLogger): Promise<VideoJson | null> {
  const running = videoJsonInFlight.get(url);
  if (running) return running;
  const started = buildVideoJson(url, logger).finally(() => videoJsonInFlight.delete(url));
  videoJsonInFlight.set(url, started);
  return started;
}

/** For tests: the in-flight map must not leak a rejected run between cases. */
export function resetVideoJsonInFlight(): void {
  videoJsonInFlight.clear();
}

/** Reads the track list, and returns the JSON it came from when this call fetched it. */
async function loadAvailableSubtitles(
  url: string,
  logger?: FastifyBaseLogger
): Promise<AvailableSubtitles & { data?: YtDlpVideoInfo }> {
  const cacheKey = buildCacheKey('avail', url);
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as AvailableSubtitles;
      recordCacheHit('avail');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  recordCacheMiss('avail');

  const loaded = await loadVideoJson(url, logger);
  if (!loaded) {
    throw new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found');
  }
  return { ...loaded.avail, data: loaded.data };
}

/**
 * Waits for the Whisper job or for the per-request deadline, whichever answers first. The
 * loser has to be cleaned up: an uncleared WHISPER_TIMEOUT timer holds its callback — and
 * the event loop — for the full ten minutes after the job already answered.
 */
async function raceWhisperJob<T>(
  job: Promise<T>,
  timeoutMs: number
): Promise<{ kind: 'done'; content: T } | { kind: 'timeout' }> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    job.then((content) => ({ kind: 'done' as const, content })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

async function throwNoSubtitlesError(opts: {
  url: string;
  /** What the caller asked for by name; absent means auto-discovery chose. */
  asked?: { type: 'official' | 'auto'; lang: string; defaulted: boolean };
  /** The list the caller already read; without it this costs another yt-dlp run. */
  available?: AvailableSubtitles;
  logger?: FastifyBaseLogger;
}): Promise<never> {
  const whisperTried = getWhisperConfig().mode !== 'off';
  const available =
    opts.available ??
    (await validateAndFetchAvailableSubtitles({ url: opts.url }, opts.logger).catch(
      (err: unknown) => {
        // A known reason (private, removed…) is the real answer: "no subtitles for en"
        // would send the caller through other languages. Counted by the caller's catch.
        if (err instanceof YtDlpError) throw err;
        return undefined;
      }
    ));
  if (whisperTried) recordSubtitlesFailure(opts.url, 'no_subtitles');

  const base = !opts.asked
    ? `No subtitles could be downloaded for this video (auto-discovery asked for at most ${AUTO_DISCOVERY_ATTEMPTS} of the tracks this platform lists, best match first).`
    : `No ${opts.asked.type} subtitles could be downloaded for language "${opts.asked.lang}".` +
      (opts.asked.defaulted
        ? ' When only one of type and lang is given, the other defaults to type "auto" and lang "en".'
        : '');

  // A length ceiling means the job will never run for this video again, so the useful next
  // step is a different track rather than another wait — that is what the ladder below reads.
  const whisperCeiling = parseIntEnv('WHISPER_MAX_DURATION_SECONDS', 0);
  const verdict = !whisperTried
    ? 'This server does not transcribe audio.'
    : whisperCeiling > 0
      ? `Speech-to-text produced nothing either; this server transcribes only videos up to ${whisperCeiling} seconds long.`
      : 'Speech-to-text was also tried and produced nothing; if it timed out it may still finish in the background.';

  // "Could not be read" and "is empty" are different answers: one says try again another
  // way, the other says nothing will work. Collapsing them is the mistake to avoid here.
  const trackFact =
    available === undefined
      ? 'The list of available tracks could not be read either.'
      : available.official.length === 0 && available.auto.length === 0
        ? 'The platform lists no subtitle tracks for this video, so no type or lang will work.'
        : '';

  // Exactly one next step, whatever the branch: two of them in one message is how a
  // caller ends up repeating the call it was just told not to repeat.
  const nextStep =
    whisperTried && whisperCeiling === 0
      ? 'You may retry the same call once in a few minutes; if it fails again, do not retry.'
      : trackFact !== ''
        ? 'Do not repeat the same call.'
        : !opts.asked
          ? 'To try a track auto-discovery skipped, pass type and lang explicitly.'
          : 'Omit type and lang to let the server choose, or pass a type and lang the video actually has.';

  throw new NotFoundError(
    [base, verdict, trackFact, nextStep].filter((part) => part !== '').join(' '),
    'Subtitles not found',
    available
      ? {
          official: available.official,
          auto: available.auto,
          ...(opts.asked ? { tried: opts.asked.lang } : {}),
        }
      : undefined
  );
}

type SubtitleResult = {
  videoId: string;
  type: 'official' | 'auto';
  lang: string;
  subtitlesContent: string;
  source?: string;
};

async function handleAutoDiscoverFlow(
  request: GetSubtitlesRequest,
  url: string,
  logger?: FastifyBaseLogger
): Promise<SubtitleResult> {
  const format = request.format as SubtitleFormat | undefined;
  const cacheConfig = getCacheConfig();
  // Keyed by the format the content is in: a call without `format` and one naming the
  // server default get the same text, so they share one entry.
  const cacheKey = buildCacheKey('sub', url, 'auto-discovery', resolveSubtitleFormat(format));
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as SubtitleResult;
      recordCacheHit('sub');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  recordCacheMiss('sub');
  // Before the metadata run, not after it: a held request must cost the caller nothing and
  // must not reach the platform at all.
  assertSubtitlesNotRateLimited(url);

  const result = await downloadWithAutoDiscover(url, format, logger, {
    key: cacheKey,
    ttl: cacheConfig.ttlSubtitlesSeconds,
  });
  if (!result) {
    await throwNoSubtitlesError({ url, logger });
  }

  const found = result as SubtitleResult;
  await set(cacheKey, JSON.stringify(found), cacheConfig.ttlSubtitlesSeconds);
  // The transcript widget then asks for the track it shows by name, which is the
  // explicit flow's key: store the same text there too, under the name that flow
  // sanitizes it to. Whisper finds no track (lang ''), so it gets no second entry.
  const trackLang = sanitizeLang(found.lang);
  if (trackLang) {
    await set(
      buildCacheKey('sub', url, found.type, trackLang, resolveSubtitleFormat(format)),
      JSON.stringify(found),
      cacheConfig.ttlSubtitlesSeconds
    );
  }
  return found;
}

async function handleExplicitRequestFlow(
  request: GetSubtitlesRequest,
  url: string,
  logger?: FastifyBaseLogger,
  skipCache = false
): Promise<SubtitleResult> {
  const type = request.type ?? 'auto';
  const lang = request.lang ?? 'en';
  const format = request.format as SubtitleFormat | undefined;

  const sanitizedLang = sanitizeLang(lang);
  if (!sanitizedLang) {
    throw new ValidationError(INVALID_LANGUAGE_MESSAGE, 'Invalid language code');
  }

  const cacheConfig = getCacheConfig();
  const cacheKey = buildCacheKey('sub', url, type, sanitizedLang, resolveSubtitleFormat(format));
  // The canary skips the cache: a cached fixture proves Redis works, not yt-dlp.
  const cached = skipCache ? undefined : await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as SubtitleResult;
      recordCacheHit('sub');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  if (!skipCache) recordCacheMiss('sub');
  assertSubtitlesNotRateLimited(url);

  // The JSON gives the video id and fills the info, track-list and chapters caches that
  // the widgets ask for right after a transcript. The canary keeps its single yt-dlp run
  // and skips this; everyone else gets three warm cache entries.
  const loaded = skipCache ? null : await loadVideoJson(url, logger);
  let subtitlesContent = await downloadSubtitles(url, type, sanitizedLang, format, logger);
  let source: string = extractPlatformFromUrl(url);

  if (!subtitlesContent) {
    const whisperConfig = getWhisperConfig();
    if (whisperConfig.mode !== 'off') {
      logger?.info({ lang: sanitizedLang }, 'Trying Whisper fallback');
      const job = startOrReuseWhisperJob(url, sanitizedLang, 'srt', logger);
      const outcome = await raceWhisperJob(job, whisperConfig.timeout);

      if (outcome.kind === 'timeout') {
        void job.then(async (text) => {
          if (!text?.trim()) {
            return;
          }
          const vid = loaded?.info.videoId ?? extractYouTubeVideoId(url) ?? 'unknown';
          const whisperResult = {
            videoId: vid,
            type,
            lang: sanitizedLang,
            subtitlesContent: text,
            source: 'whisper',
          };
          await set(cacheKey, JSON.stringify(whisperResult), cacheConfig.ttlSubtitlesSeconds);
        });
      } else if (outcome.content) {
        subtitlesContent = outcome.content;
        source = 'whisper';
      }
    }
  }

  if (!subtitlesContent) {
    await throwNoSubtitlesError({
      url,
      // Only one of the two given means the server substituted the other, and the caller
      // cannot see which value it substituted unless the text says so.
      asked: {
        type,
        lang: sanitizedLang,
        defaulted: (request.type === undefined) !== (request.lang === undefined),
      },
      available: loaded?.avail,
      logger,
    });
  }

  const videoId = loaded?.info.videoId ?? extractYouTubeVideoId(url) ?? 'unknown';

  const result: SubtitleResult = {
    videoId,
    type,
    lang: sanitizedLang,
    subtitlesContent: subtitlesContent as string,
    source,
  };
  if (!skipCache) await set(cacheKey, JSON.stringify(result), cacheConfig.ttlSubtitlesSeconds);
  return result;
}

/**
 * Validates request and downloads subtitles (supported platforms or Whisper fallback).
 * When type and lang are both omitted, uses auto-discovery: official → auto (-orig for YouTube) → Whisper.
 * @param logger - Fastify logger instance for structured logging
 * @returns object with subtitle data
 * @throws ValidationError on invalid input, NotFoundError when subtitles are not available
 */
export async function validateAndDownloadSubtitles(
  request: GetSubtitlesRequest,
  logger?: FastifyBaseLogger,
  opts?: { skipCache?: boolean }
): Promise<SubtitleResult> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  try {
    if (shouldAutoDiscoverSubtitles(request)) {
      return await handleAutoDiscoverFlow(request, url, logger);
    }
    return await handleExplicitRequestFlow(request, url, logger, opts?.skipCache);
  } catch (err) {
    if (err instanceof YtDlpError) recordSubtitlesFailure(url, err.reason);
    throw err;
  }
}

/**
 * Validates request and returns available subtitles for a video
 * @param logger - Fastify logger instance for structured logging
 * @returns object with available subtitles data
 * @throws ValidationError on invalid input, NotFoundError when video is not found
 */
export async function validateAndFetchAvailableSubtitles(
  request: GetAvailableSubtitlesRequest,
  logger?: FastifyBaseLogger
): Promise<AvailableSubtitles> {
  const { url } = validateVideoRequest(request.url);
  const { videoId, official, auto } = await loadAvailableSubtitles(url, logger);
  return { videoId, official, auto };
}

/**
 * Validates request and returns video info
 * @throws ValidationError on invalid input, NotFoundError when video is not found
 */
export async function validateAndFetchVideoInfo(
  request: GetVideoInfoRequest,
  logger?: FastifyBaseLogger
): Promise<{ videoId: string; info: NonNullable<Awaited<ReturnType<typeof fetchVideoInfo>>> }> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  const cacheKey = buildCacheKey('info', url);
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as {
        videoId: string;
        info: NonNullable<Awaited<ReturnType<typeof fetchVideoInfo>>>;
      };
      recordCacheHit('info');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  recordCacheMiss('info');

  const loaded = await loadVideoJson(url, logger);
  const info = loaded?.info.info;
  if (!info) {
    throw new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found');
  }
  return { videoId: loaded.info.videoId, info };
}

/**
 * Validates request and returns video chapters
 * @throws ValidationError on invalid input, NotFoundError when video/chapters are not found
 */
export async function validateAndFetchVideoChapters(
  request: GetVideoInfoRequest,
  logger?: FastifyBaseLogger
): Promise<{ videoId: string; chapters: Awaited<ReturnType<typeof fetchVideoChapters>> }> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  const cacheKey = buildCacheKey('chapters', url);
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as {
        videoId: string;
        chapters: Awaited<ReturnType<typeof fetchVideoChapters>>;
      };
      recordCacheHit('chapters');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  recordCacheMiss('chapters');

  const loaded = await loadVideoJson(url, logger);
  if (!loaded || loaded.chapters.chapters === null) {
    throw new NotFoundError(UNKNOWN_FAILURE_MESSAGE, 'Video not found');
  }
  return loaded.chapters;
}

export const FRAME_MIN_WIDTH = 64;
export const FRAME_MAX_WIDTH = 1920;
export const FRAME_DEFAULT_WIDTH = 1280;
export const FRAME_DEFAULT_JPEG_QUALITY = 4;

export type CaptureFrameRequest = {
  url: string;
  /** Timestamp as "MM:SS" or "HH:MM:SS" with optional ".mmm" fraction */
  timecode?: string;
  /** Timestamp in seconds (alternative to timecode) */
  seconds?: number;
  format?: VideoFrameFormat;
  width?: number;
  quality?: number;
};

export type CaptureFrameResult = {
  videoId: string;
  /** The page the frame was taken from, as the server resolved it. */
  url: string;
  timestampSeconds: number;
  /** Timestamp formatted as "HH:MM:SS.mmm" */
  timestamp: string;
  mimeType: string;
  sizeBytes: number;
  /** Actual output image width; null when it could not be read from image headers */
  width: number | null;
  data: Buffer;
};

/**
 * Parses "MM:SS" or "HH:MM:SS" with optional ".mmm" fraction into seconds.
 * Returns null for invalid input.
 */
export function parseTimecode(timecode: string): number | null {
  const match = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(timecode.trim());
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  if (minutes > 59 || seconds > 59) {
    return null;
  }
  const millis = match[4] ? Number.parseInt(match[4].padEnd(3, '0'), 10) : 0;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Formats seconds as "HH:MM:SS.mmm". */
export function formatTimestamp(totalSeconds: number): string {
  const totalMillis = Math.round(totalSeconds * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(millis).padStart(3, '0')}`;
}

function resolveFrameTimestamp(request: CaptureFrameRequest): number {
  if (request.timecode !== undefined && request.seconds !== undefined) {
    throw new ValidationError('Provide either timecode or seconds, not both', 'Invalid timestamp');
  }
  if (request.timecode !== undefined) {
    const parsed = parseTimecode(request.timecode);
    if (parsed === null) {
      throw new ValidationError(
        'Invalid timecode. Use "MM:SS" or "HH:MM:SS" with optional ".mmm", e.g. "01:23" or "00:01:23.500"',
        'Invalid timestamp'
      );
    }
    return parsed;
  }
  if (request.seconds !== undefined) {
    if (!Number.isFinite(request.seconds) || request.seconds < 0) {
      throw new ValidationError(
        'seconds must be a non-negative finite number',
        'Invalid timestamp'
      );
    }
    return request.seconds;
  }
  return 0;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** One capture per identical argument set while it runs; a repeated call waits for it. */
const frameInFlight = new Map<string, ReturnType<typeof captureVideoFrame>>();

/**
 * Validates request and captures a single video frame at the given timestamp.
 * @throws ValidationError on invalid input or timestamp beyond video duration,
 *         NotFoundError when the frame could not be captured
 */
export async function validateAndCaptureVideoFrame(
  request: CaptureFrameRequest,
  logger?: FastifyBaseLogger
): Promise<CaptureFrameResult> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  const timestampSeconds = resolveFrameTimestamp(request);
  const format: VideoFrameFormat = request.format ?? 'jpeg';
  const width = clampInt(request.width ?? FRAME_DEFAULT_WIDTH, FRAME_MIN_WIDTH, FRAME_MAX_WIDTH);
  const quality = clampInt(request.quality ?? FRAME_DEFAULT_JPEG_QUALITY, 2, 31);

  // A client that gives up waiting calls again with the same arguments; the second call
  // waits for the first capture instead of starting another one next to it.
  const key = JSON.stringify([url, timestampSeconds, format, width, quality]);
  let capture = frameInFlight.get(key);
  if (!capture) {
    capture = captureVideoFrame(url, timestampSeconds, { format, width, quality }, logger).finally(
      () => frameInFlight.delete(key)
    );
    frameInFlight.set(key, capture);
  }
  const outcome = await capture;

  if (!outcome.ok) {
    if (outcome.reason === 'timestamp_beyond_duration') {
      throw new ValidationError(
        `Timestamp ${formatTimestamp(timestampSeconds)} is beyond the video duration (${outcome.durationSeconds}s)`,
        'Invalid timestamp'
      );
    }
    throw new NotFoundError(
      `Could not capture a frame at ${formatTimestamp(timestampSeconds)}: the server could not read the video stream.` +
        (timestampSeconds > 0
          ? ' If the timestamp may be past the end of the video, retry once with an earlier one; otherwise do not retry'
          : ' Do not retry') +
        " — get_video_info returns the video's thumbnail.",
      'Frame capture failed'
    );
  }

  return {
    videoId: outcome.videoId,
    url,
    timestampSeconds,
    timestamp: formatTimestamp(timestampSeconds),
    mimeType: outcome.mimeType,
    sizeBytes: outcome.data.length,
    width: getImageWidth(outcome.data),
    data: outcome.data,
  };
}
