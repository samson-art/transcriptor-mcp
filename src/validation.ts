import { FastifyReply, FastifyBaseLogger } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import {
  extractVideoId,
  downloadSubtitles,
  fetchVideoInfo,
  fetchVideoChapters,
  fetchYtDlpJson,
} from './youtube.js';
import { getWhisperConfig, transcribeWithWhisper } from './whisper.js';

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
    return extractVideoId(url) !== null;
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
 * Sends 400 on validation failure.
 */
export function validateVideoRequest(url: string, reply: FastifyReply): { url: string } | null {
  const normalized = normalizeVideoInput(url);
  if (!normalized) {
    reply.code(400).send({
      error: 'Invalid video URL',
      message:
        'Please provide a valid video URL (YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion) or YouTube video ID',
    });
    return null;
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
 * Sends error response and returns null on validation failure.
 * @param url - YouTube video URL from request
 * @param reply - Fastify reply to send error responses
 * @returns object with videoId or null
 */
export function validateYouTubeRequest(
  url: string,
  reply: FastifyReply
): { videoId: string } | null {
  if (!isValidYouTubeUrl(url)) {
    reply.code(400).send({
      error: 'Invalid YouTube URL',
      message: 'Please provide a valid YouTube video URL',
    });
    return null;
  }

  const extractedVideoId = extractVideoId(url);
  if (!extractedVideoId) {
    reply.code(400).send({
      error: 'Invalid YouTube URL',
      message: 'Could not extract video ID from the provided URL',
    });
    return null;
  }

  const videoId = sanitizeVideoId(extractedVideoId);
  if (!videoId) {
    reply.code(400).send({
      error: 'Invalid video ID',
      message: 'Video ID contains invalid characters',
    });
    return null;
  }

  return { videoId };
}

/**
 * Validates request and downloads subtitles (supported platforms or Whisper fallback).
 * @param logger - Fastify logger instance for structured logging
 * @returns object with subtitle data or null in case of error
 */
export async function validateAndDownloadSubtitles(
  request: GetSubtitlesRequest,
  reply: FastifyReply,
  logger?: FastifyBaseLogger
): Promise<{
  videoId: string;
  type: 'official' | 'auto';
  lang: string;
  subtitlesContent: string;
  source?: 'youtube' | 'whisper';
} | null> {
  const validated = validateVideoRequest(request.url, reply);
  if (!validated) {
    return null;
  }

  const { url } = validated;
  const { type = 'auto', lang = 'en' } = request;

  const sanitizedLang = sanitizeLang(lang);
  if (!sanitizedLang) {
    reply.code(400).send({
      error: 'Invalid language code',
      message: 'Language code contains invalid characters',
    });
    return null;
  }

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
    reply.code(404).send({
      error: 'Subtitles not found',
      message: `No ${type} subtitles available for language "${sanitizedLang}"`,
    });
    return null;
  }

  const data = await fetchYtDlpJson(url, logger);
  const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';

  return { videoId, type, lang: sanitizedLang, subtitlesContent, source };
}

/**
 * Validates request and returns available subtitles for a video
 * @param logger - Fastify logger instance for structured logging
 * @returns object with available subtitles data or null in case of error
 */
export async function validateAndFetchAvailableSubtitles(
  request: GetAvailableSubtitlesRequest,
  reply: FastifyReply,
  logger?: FastifyBaseLogger
): Promise<{
  videoId: string;
  official: string[];
  auto: string[];
} | null> {
  const validated = validateVideoRequest(request.url, reply);
  if (!validated) {
    return null;
  }

  const { url } = validated;
  const data = await fetchYtDlpJson(url, logger);
  if (!data) {
    reply.code(404).send({
      error: 'Video not found',
      message: 'Could not fetch video data for the provided URL',
    });
    return null;
  }

  const videoId = data.id ?? extractVideoId(url) ?? 'unknown';
  const official = data.subtitles
    ? Object.keys(data.subtitles).sort((a, b) => a.localeCompare(b))
    : [];
  const auto = data.automatic_captions
    ? Object.keys(data.automatic_captions).sort((a, b) => a.localeCompare(b))
    : [];

  return { videoId, official, auto };
}

/**
 * Validates request and returns video info
 */
export async function validateAndFetchVideoInfo(
  request: GetVideoInfoRequest,
  reply: FastifyReply,
  logger?: FastifyBaseLogger
): Promise<{ videoId: string; info: Awaited<ReturnType<typeof fetchVideoInfo>> } | null> {
  const validated = validateVideoRequest(request.url, reply);
  if (!validated) {
    return null;
  }

  const { url } = validated;
  const info = await fetchVideoInfo(url, logger);
  if (!info) {
    reply.code(404).send({
      error: 'Video not found',
      message: 'Could not fetch video info for the provided URL',
    });
    return null;
  }

  const videoId = info.id ?? extractVideoId(url) ?? 'unknown';
  return { videoId, info };
}

/**
 * Validates request and returns video chapters
 */
export async function validateAndFetchVideoChapters(
  request: GetVideoInfoRequest,
  reply: FastifyReply,
  logger?: FastifyBaseLogger
): Promise<{ videoId: string; chapters: Awaited<ReturnType<typeof fetchVideoChapters>> } | null> {
  const validated = validateVideoRequest(request.url, reply);
  if (!validated) {
    return null;
  }

  const { url } = validated;
  const data = await fetchYtDlpJson(url, logger);
  const videoId = data?.id ?? extractVideoId(url) ?? 'unknown';
  const chapters = await fetchVideoChapters(url, logger);
  if (chapters === null) {
    reply.code(404).send({
      error: 'Video not found',
      message: 'Could not fetch chapters for the provided URL',
    });
    return null;
  }

  return { videoId, chapters };
}
