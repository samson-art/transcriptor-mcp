import { FastifyBaseLogger } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import { NotFoundError, ValidationError } from './errors.js';
import {
  extractYouTubeVideoId,
  downloadSubtitles,
  fetchVideoInfo,
  fetchVideoChapters,
  fetchYtDlpJson,
} from './youtube.js';
import { getWhisperConfig, transcribeWithWhisper } from './whisper.js';
import { getCacheConfig, get, set } from './cache.js';
import { recordCacheHit, recordCacheMiss } from './metrics.js';

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
  'dailymotion.com',
  'www.dailymotion.com',
] as const;

// TypeBox schema for subtitle request
export const GetSubtitlesRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'Video URL from a supported platform (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion) or YouTube video ID',
  }),
  type: Type.Optional(
    Type.Union([Type.Literal('official'), Type.Literal('auto')], {
      default: 'auto',
      description: 'Type of subtitles: official or auto-generated',
    })
  ),
  lang: Type.Optional(
    Type.String({
      pattern: '^[a-zA-Z0-9-]+$',
      minLength: 1,
      maxLength: 10,
      default: 'en',
      description: 'Language code (e.g., en, ru, en-US)',
    })
  ),
});

export type GetSubtitlesRequest = Static<typeof GetSubtitlesRequestSchema>;

// Schema for request to get available subtitles
export const GetAvailableSubtitlesRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description: 'Video URL from a supported platform or YouTube video ID',
  }),
});

export type GetAvailableSubtitlesRequest = Static<typeof GetAvailableSubtitlesRequestSchema>;

// Schema for request to get video info or chapters
export const GetVideoInfoRequestSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description: 'Video URL from a supported platform or YouTube video ID',
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
      'Please provide a valid video URL (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion) or YouTube video ID',
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

/**
 * Validates request and downloads subtitles (supported platforms or Whisper fallback).
 * @param logger - Fastify logger instance for structured logging
 * @returns object with subtitle data
 * @throws ValidationError on invalid input, NotFoundError when subtitles are not available
 */
export async function validateAndDownloadSubtitles(
  request: GetSubtitlesRequest,
  logger?: FastifyBaseLogger
): Promise<{
  videoId: string;
  type: 'official' | 'auto';
  lang: string;
  subtitlesContent: string;
  source?: 'youtube' | 'whisper';
}> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;
  const { type = 'auto', lang = 'en' } = request;

  const sanitizedLang = sanitizeLang(lang);
  if (!sanitizedLang) {
    throw new ValidationError('Language code contains invalid characters', 'Invalid language code');
  }

  const cacheConfig = getCacheConfig();
  const cacheKey = `sub:${url}:${type}:${sanitizedLang}`;
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    return JSON.parse(cached) as {
      videoId: string;
      type: 'official' | 'auto';
      lang: string;
      subtitlesContent: string;
      source?: 'youtube' | 'whisper';
    };
  }
  recordCacheMiss();

  let subtitlesContent = await downloadSubtitles(url, type, sanitizedLang, logger);
  let source: 'youtube' | 'whisper' = 'youtube';

  if (!subtitlesContent) {
    const whisperConfig = getWhisperConfig();
    if (whisperConfig.mode !== 'off') {
      logger?.info({ lang: sanitizedLang }, 'Trying Whisper fallback');
      subtitlesContent = await transcribeWithWhisper(url, sanitizedLang, 'srt', logger);
      source = 'whisper';
    }
  }

  if (!subtitlesContent) {
    throw new NotFoundError(
      `No ${type} subtitles available for language "${sanitizedLang}"`,
      'Subtitles not found'
    );
  }

  const data = await fetchYtDlpJson(url, logger);
  const videoId = data?.id ?? extractYouTubeVideoId(url) ?? 'unknown';

  const result = { videoId, type, lang: sanitizedLang, subtitlesContent, source };
  await set(cacheKey, JSON.stringify(result), cacheConfig.ttlSubtitlesSeconds);
  return result;
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
): Promise<{
  videoId: string;
  official: string[];
  auto: string[];
}> {
  const validated = validateVideoRequest(request.url);
  const { url } = validated;

  const cacheConfig = getCacheConfig();
  const cacheKey = `avail:${url}`;
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    return JSON.parse(cached) as { videoId: string; official: string[]; auto: string[] };
  }
  recordCacheMiss();

  const data = await fetchYtDlpJson(url, logger);
  if (!data) {
    throw new NotFoundError('Could not fetch video data for the provided URL', 'Video not found');
  }

  const videoId = data.id ?? extractYouTubeVideoId(url) ?? 'unknown';
  const official = data.subtitles
    ? Object.keys(data.subtitles).sort((a, b) => a.localeCompare(b))
    : [];
  const auto = data.automatic_captions
    ? Object.keys(data.automatic_captions).sort((a, b) => a.localeCompare(b))
    : [];

  const result = { videoId, official, auto };
  await set(cacheKey, JSON.stringify(result), cacheConfig.ttlMetadataSeconds);
  return result;
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

  const cacheConfig = getCacheConfig();
  const cacheKey = `info:${url}`;
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    return JSON.parse(cached) as {
      videoId: string;
      info: Awaited<ReturnType<typeof fetchVideoInfo>>;
    };
  }
  recordCacheMiss();

  const info = await fetchVideoInfo(url, logger);
  if (!info) {
    throw new NotFoundError('Could not fetch video info for the provided URL', 'Video not found');
  }

  const videoId = info.id ?? extractYouTubeVideoId(url) ?? 'unknown';
  const result = { videoId, info };
  await set(cacheKey, JSON.stringify(result), cacheConfig.ttlMetadataSeconds);
  return result;
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

  const cacheConfig = getCacheConfig();
  const cacheKey = `chapters:${url}`;
  const cached = await get(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    return JSON.parse(cached) as {
      videoId: string;
      chapters: Awaited<ReturnType<typeof fetchVideoChapters>>;
    };
  }
  recordCacheMiss();

  const data = await fetchYtDlpJson(url, logger);
  const videoId = data?.id ?? extractYouTubeVideoId(url) ?? 'unknown';
  const chapters = await fetchVideoChapters(url, logger, data);
  if (chapters === null) {
    throw new NotFoundError('Could not fetch chapters for the provided URL', 'Video not found');
  }

  const result = { videoId, chapters };
  await set(cacheKey, JSON.stringify(result), cacheConfig.ttlMetadataSeconds);
  return result;
}
