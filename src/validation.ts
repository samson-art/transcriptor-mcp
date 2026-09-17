import { FastifyBaseLogger } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import { NotFoundError, ValidationError, YtDlpError } from './errors.js';
import {
  extractYouTubeVideoId,
  downloadSubtitles,
  fetchVideoInfo,
  fetchVideoChapters,
  fetchYtDlpJson,
  captureVideoFrame,
  getImageWidth,
  mapVideoInfo,
  type SubtitleFormat,
  type YtDlpVideoInfo,
  type VideoFrameFormat,
} from './youtube.js';
import { getWhisperConfig } from './whisper.js';
import { parseIntEnv } from './env.js';
import { startOrReuseWhisperJob } from './whisper-jobs.js';
import { getCacheConfig, get, set, buildCacheKey } from './cache.js';
import { recordCacheHit, recordCacheMiss, recordSubtitlesFailure } from './metrics.js';

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
      pattern: '^[a-zA-Z0-9-]+$',
      minLength: 1,
      maxLength: 10,
      description: 'Language code (e.g., en, ru, en-US). Omit with type for auto-discovery.',
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
    throw new ValidationError(
      'Please provide a valid video URL (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, Reddit) or YouTube video ID',
      'Invalid video URL'
    );
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
 * Sanitizes language code - allows only safe characters
 * @param lang - language code to sanitize
 * @returns sanitized language code or null if contains invalid characters
 */
export function sanitizeLang(lang: string): string | null {
  if (!lang || typeof lang !== 'string') {
    return null;
  }

  // Language code usually contains only letters, numbers and hyphens (e.g., en, en-US, ru)
  const sanitized = lang.trim();
  if (!/^[a-zA-Z0-9-]+$/.test(sanitized)) {
    return null;
  }

  // Limit length for security
  if (sanitized.length > 10) {
    return null;
  }

  return sanitized;
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

/** Order auto languages for YouTube: -orig first, then rest. */
function orderAutoForYouTube(auto: string[]): string[] {
  const withOrig = auto.filter((l) => l.endsWith('-orig'));
  const withoutOrig = auto.filter((l) => !l.endsWith('-orig'));
  return [...withOrig, ...withoutOrig];
}

/** Extracts platform identifier from input URL hostname (youtube, reddit, vimeo, etc.). */
export function extractPlatformFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('reddit') || hostname.includes('v.redd.it')) return 'reddit';
    if (hostname.includes('vimeo')) return 'vimeo';
    if (hostname.includes('tiktok')) return 'tiktok';
    if (hostname.includes('twitch')) return 'twitch';
    if (hostname.includes('twitter') || hostname === 'x.com' || hostname.endsWith('.x.com'))
      return 'twitter';
    if (hostname.includes('instagram')) return 'instagram';
    if (hostname.includes('facebook') || hostname.includes('fb.')) return 'facebook';
    if (hostname.includes('bilibili')) return 'bilibili';
    if (
      hostname === 'vk.com' ||
      hostname.endsWith('.vk.com') ||
      hostname === 'vk.ru' ||
      hostname.endsWith('.vk.ru') ||
      hostname === 'vkvideo.ru' ||
      hostname.endsWith('.vkvideo.ru')
    )
      return 'vk';
    if (hostname.includes('dailymotion')) return 'dailymotion';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

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
  const isYouTube = extractYouTubeVideoId(url) !== null;
  const platform = extractPlatformFromUrl(url);

  // 1. Try official subtitles (limit to first 3 to avoid O(N) yt-dlp calls)
  const officialToTry = official.slice(0, 3);
  for (const lang of officialToTry) {
    const content = await downloadSubtitles(url, 'official', lang, format, logger, data);
    if (content && content.trim().length > 0) {
      return {
        videoId,
        type: 'official',
        lang,
        subtitlesContent: content,
        source: platform,
      };
    }
  }

  // 2. Try auto subtitles (for YouTube: -orig first; limit to first 3 to avoid O(N) yt-dlp calls)
  const orderedAuto = isYouTube ? orderAutoForYouTube(auto) : auto;
  const autoToTry = orderedAuto.slice(0, 3);
  for (const lang of autoToTry) {
    const content = await downloadSubtitles(url, 'auto', lang, format, logger, data);
    if (content && content.trim().length > 0) {
      return {
        videoId,
        type: 'auto',
        lang,
        subtitlesContent: content,
        source: platform,
      };
    }
  }

  // 3. Whisper fallback (background job: survives per-request WHISPER_TIMEOUT for cache)
  const whisperConfig = getWhisperConfig();
  if (whisperConfig.mode !== 'off') {
    logger?.info('Trying Whisper fallback for auto-discovery');
    const job = startOrReuseWhisperJob(url, '', 'srt', logger);
    const outcome = await Promise.race([
      job.then((content) => ({ kind: 'done' as const, content })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), whisperConfig.timeout);
      }),
    ]);

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
    throw new NotFoundError('Could not fetch video data for the provided URL', 'Video not found');
  }
  return { ...loaded.avail, data: loaded.data };
}

/** Told to the caller when Whisper is on and produced nothing; operator settings stay out of it. */
function whisperHint(): string {
  const maxSeconds = parseIntEnv('WHISPER_MAX_DURATION_SECONDS', 0);
  return maxSeconds > 0
    ? `Speech-to-text produced nothing either; this server transcribes only videos up to ${maxSeconds} seconds long. Do not repeat the same call.`
    : 'Speech-to-text was also tried and produced nothing; if it timed out it may still finish in the background, so you may retry the same call once in a few minutes.';
}

async function throwNoSubtitlesError(opts: {
  url: string;
  baseMsg: string;
  whisperHintPrefix: '' | ' ';
  whisperTried: boolean;
  /** The list the caller already read; without it this costs another yt-dlp run. */
  available?: AvailableSubtitles;
  logger?: FastifyBaseLogger;
}): Promise<never> {
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
  if (opts.whisperTried) recordSubtitlesFailure(opts.url, 'no_subtitles');
  const hint = opts.whisperTried ? `${opts.whisperHintPrefix}${whisperHint()}` : '';
  throw new NotFoundError(
    `${opts.baseMsg}${hint} Use get_available_subtitles (or GET /subtitles/available) to list supported languages, or omit type and lang for auto-discovery.`,
    'Subtitles not found',
    available ? { official: available.official, auto: available.auto } : undefined
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
  const cacheKey = buildCacheKey('sub', url, 'auto-discovery', format ?? 'default');
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

  const result = await downloadWithAutoDiscover(url, format, logger, {
    key: cacheKey,
    ttl: cacheConfig.ttlSubtitlesSeconds,
  });
  if (!result) {
    const whisperTried = getWhisperConfig().mode !== 'off';
    await throwNoSubtitlesError({
      url,
      baseMsg: 'No subtitles available (tried official, auto, and Whisper fallback). ',
      whisperHintPrefix: '',
      whisperTried,
      logger,
    });
  }

  await set(cacheKey, JSON.stringify(result), cacheConfig.ttlSubtitlesSeconds);
  return result as SubtitleResult;
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
    throw new ValidationError('Language code contains invalid characters', 'Invalid language code');
  }

  const cacheConfig = getCacheConfig();
  const cacheKey = buildCacheKey('sub', url, type, sanitizedLang, format ?? 'default');
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

  // The JSON carries the track's own URL and the video id, and fills the info, track-list
  // and chapters caches that the widgets ask for right after a transcript.
  // The canary proves the yt-dlp caption path still works, so it skips this and keeps its
  // single run; everyone else gets the track URL and three warm cache entries.
  const loaded = skipCache ? null : await loadVideoJson(url, logger);
  let subtitlesContent = await downloadSubtitles(
    url,
    type,
    sanitizedLang,
    format,
    logger,
    loaded?.data
  );
  let source: string = extractPlatformFromUrl(url);

  if (!subtitlesContent) {
    const whisperConfig = getWhisperConfig();
    if (whisperConfig.mode !== 'off') {
      logger?.info({ lang: sanitizedLang }, 'Trying Whisper fallback');
      const job = startOrReuseWhisperJob(url, sanitizedLang, 'srt', logger);
      const outcome = await Promise.race([
        job.then((content) => ({ kind: 'done' as const, content })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), whisperConfig.timeout);
        }),
      ]);

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
    const whisperTried = getWhisperConfig().mode !== 'off';
    await throwNoSubtitlesError({
      url,
      baseMsg: `No subtitles for language "${sanitizedLang}".`,
      whisperHintPrefix: ' ',
      whisperTried,
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
): Promise<{ videoId: string; info: Awaited<ReturnType<typeof fetchVideoInfo>> }> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  const cacheKey = buildCacheKey('info', url);
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as {
        videoId: string;
        info: Awaited<ReturnType<typeof fetchVideoInfo>>;
      };
      recordCacheHit('info');
      return parsed;
    } catch (e) {
      logger?.warn({ err: e, cacheKey }, 'Corrupted cache entry, treating as miss');
    }
  }
  recordCacheMiss('info');

  const loaded = await loadVideoJson(url, logger);
  if (!loaded?.info.info) {
    throw new NotFoundError('Could not fetch video info for the provided URL', 'Video not found');
  }
  return loaded.info;
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
    throw new NotFoundError('Could not fetch chapters for the provided URL', 'Video not found');
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

  const outcome = await captureVideoFrame(
    url,
    timestampSeconds,
    { format, width, quality },
    logger
  );

  if (!outcome.ok) {
    if (outcome.reason === 'timestamp_beyond_duration') {
      throw new ValidationError(
        `Timestamp ${formatTimestamp(timestampSeconds)} is beyond the video duration (${outcome.durationSeconds}s)`,
        'Invalid timestamp'
      );
    }
    throw new NotFoundError('Failed to capture a frame for this video.', 'Frame capture failed');
  }

  return {
    videoId: outcome.videoId,
    timestampSeconds,
    timestamp: formatTimestamp(timestampSeconds),
    mimeType: outcome.mimeType,
    sizeBytes: outcome.data.length,
    width: getImageWidth(outcome.data),
    data: outcome.data,
  };
}
