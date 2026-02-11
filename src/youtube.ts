import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FastifyBaseLogger } from 'fastify';

const execFileAsync = promisify(execFile);

function isExecFileException(error: unknown): error is ExecFileException {
  return error instanceof Error && typeof (error as ExecFileException).code !== 'undefined';
}

type YtDlpChapter = {
  start_time?: number;
  end_time?: number;
  title?: string;
};

type YtDlpVideoInfo = {
  id?: string;
  title?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  duration?: number;
  description?: string;
  upload_date?: string;
  webpage_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  tags?: string[];
  categories?: string[];
  live_status?: string;
  is_live?: boolean;
  was_live?: boolean;
  availability?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; width?: number; height?: number; id?: string }>;
  chapters?: YtDlpChapter[];
  subtitles?: Record<string, Array<{ ext?: string; url?: string }>>;
  automatic_captions?: Record<string, Array<{ ext?: string; url?: string }>>;
};

export type VideoChapter = {
  startTime: number;
  endTime: number;
  title: string;
};

export type VideoInfo = {
  id: string | null;
  title: string | null;
  uploader: string | null;
  uploaderId: string | null;
  channel: string | null;
  channelId: string | null;
  channelUrl: string | null;
  duration: number | null;
  description: string | null;
  uploadDate: string | null;
  webpageUrl: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  tags: string[] | null;
  categories: string[] | null;
  liveStatus: string | null;
  isLive: boolean | null;
  wasLive: boolean | null;
  availability: string | null;
  thumbnail: string | null;
  thumbnails: Array<{ url: string; width?: number; height?: number; id?: string }> | null;
};

export type AvailableSubtitles = {
  official: string[];
  auto: string[];
};

/**
 * Extracts video ID from YouTube URL
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Downloads subtitles using yt-dlp
 * @param videoId - YouTube video ID
 * @param type - subtitle type: 'official' or 'auto'
 * @param lang - subtitle language (e.g., 'en', 'ru')
 * @param logger - Fastify logger instance for structured logging
 */
export async function downloadSubtitles(
  videoId: string,
  type: 'official' | 'auto' = 'auto',
  lang: string = 'en',
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tempDir = tmpdir();
  const timestamp = Date.now();
  const outputPath = join(tempDir, `subtitles_${videoId}_${timestamp}`);
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv } = getYtDlpEnv();

  try {
    // Build command arguments depending on subtitle type
    // Use array of arguments instead of string to prevent command injection
    const subFlag = type === 'official' ? '--write-subs' : '--write-auto-subs';
    const args = [
      subFlag,
      '--skip-download',
      '--sub-lang',
      lang, // lang is already sanitized in validation.ts
      '--sub-format',
      'srt/vtt',
      '--output',
      `${outputPath}.%(ext)s`,
      videoUrl, // videoUrl is built from sanitized videoId
    ];

    appendYtDlpEnvArgs(args, { jsRuntimes, remoteComponents, cookiesFilePathFromEnv });

    logger?.info(
      { videoId, type, lang, hasCookies: Boolean(cookiesFilePathFromEnv) },
      `Downloading ${type} subtitles for ${videoId} in language ${lang}`
    );

    try {
      // Use execFile instead of exec for safe argument passing
      // This prevents command injection as arguments are passed separately
      const timeout = process.env.YT_DLP_TIMEOUT
        ? Number.parseInt(process.env.YT_DLP_TIMEOUT, 10)
        : 60000; // 60 seconds default
      const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      });
      logger?.debug({ stdout }, 'yt-dlp stdout');
      if (stderr) logger?.debug({ stderr }, 'yt-dlp stderr');

      // Small delay in case file is still being written
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Search for downloaded subtitle file
      const subtitleFile = await findSubtitleFile(outputPath, tempDir, logger);

      if (subtitleFile) {
        const content = await readFile(subtitleFile, 'utf-8');
        // Check that file is not empty
        if (content.trim().length > 0) {
          await unlink(subtitleFile).catch(() => {});
          return content;
        }
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const execErr = isExecFileException(error) ? error : null;
      logger?.error(
        {
          error: err.message,
          videoId,
          type,
          lang,
          ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
        },
        `Error downloading ${type} subtitles for ${videoId}`
      );

      // Even if command returned an error, file might have been created
      // (e.g., with 429 error file might already be written)
      logger?.debug({ videoId }, 'Checking for subtitle file despite error...');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const subtitleFile = await findSubtitleFile(outputPath, tempDir, logger);
      logger?.debug({ videoId, subtitleFile }, 'subtitleFile found after error');

      if (subtitleFile) {
        try {
          const content = await readFile(subtitleFile, 'utf-8');
          if (content.trim().length > 0) {
            await unlink(subtitleFile).catch(() => {});
            return content;
          }
        } catch (readError) {
          logger?.error({ error: readError, videoId, subtitleFile }, 'Error reading subtitle file');
        }
      }
    }

    return null;
  } catch (error) {
    logger?.error({ error, videoId }, `Error downloading subtitles for ${videoId}`);
    return null;
  }
}

export async function fetchVideoInfo(
  videoId: string,
  logger?: FastifyBaseLogger
): Promise<VideoInfo | null> {
  const data = await fetchYtDlpJson(videoId, logger);
  if (!data) {
    return null;
  }

  return {
    id: data.id ?? null,
    title: data.title ?? null,
    uploader: data.uploader ?? null,
    uploaderId: data.uploader_id ?? null,
    channel: data.channel ?? null,
    channelId: data.channel_id ?? null,
    channelUrl: data.channel_url ?? null,
    duration: typeof data.duration === 'number' ? data.duration : null,
    description: data.description ?? null,
    uploadDate: data.upload_date ?? null,
    webpageUrl: data.webpage_url ?? null,
    viewCount: typeof data.view_count === 'number' ? data.view_count : null,
    likeCount: typeof data.like_count === 'number' ? data.like_count : null,
    commentCount: typeof data.comment_count === 'number' ? data.comment_count : null,
    tags: Array.isArray(data.tags) ? data.tags : null,
    categories: Array.isArray(data.categories) ? data.categories : null,
    liveStatus: data.live_status ?? null,
    isLive: typeof data.is_live === 'boolean' ? data.is_live : null,
    wasLive: typeof data.was_live === 'boolean' ? data.was_live : null,
    availability: data.availability ?? null,
    thumbnail: data.thumbnail ?? null,
    thumbnails: Array.isArray(data.thumbnails)
      ? data.thumbnails
          .filter(
            (t): t is { url?: string; width?: number; height?: number; id?: string } => t != null
          )
          .map((t) => ({ url: t.url ?? '', width: t.width, height: t.height, id: t.id }))
      : null,
  };
}

/**
 * Fetches chapter markers (start/end time, title) for a YouTube video via yt-dlp.
 */
export async function fetchVideoChapters(
  videoId: string,
  logger?: FastifyBaseLogger
): Promise<VideoChapter[] | null> {
  const data = await fetchYtDlpJson(videoId, logger);
  if (!data || !Array.isArray(data.chapters) || data.chapters.length === 0) {
    return data && Array.isArray(data.chapters) ? [] : null;
  }
  return data.chapters
    .filter(
      (ch): ch is YtDlpChapter & { title: string } => ch != null && typeof ch.title === 'string'
    )
    .map(
      (ch): VideoChapter => ({
        startTime: typeof ch.start_time === 'number' ? ch.start_time : 0,
        endTime: typeof ch.end_time === 'number' ? ch.end_time : 0,
        title: ch.title,
      })
    );
}

export async function fetchAvailableSubtitles(
  videoId: string,
  logger?: FastifyBaseLogger
): Promise<AvailableSubtitles | null> {
  const data = await fetchYtDlpJson(videoId, logger);
  if (!data) {
    return null;
  }

  const official = data.subtitles ? Object.keys(data.subtitles) : [];
  const auto = data.automatic_captions ? Object.keys(data.automatic_captions) : [];

  const sortedOfficial = [...official].sort((a, b) => a.localeCompare(b));
  const sortedAuto = [...auto].sort((a, b) => a.localeCompare(b));

  return {
    official: sortedOfficial,
    auto: sortedAuto,
  };
}

/**
 * Finds subtitle file in the specified directory
 * yt-dlp creates files in format: baseName.language.srt or baseName.language.vtt
 * @param logger - Fastify logger instance for structured logging
 *
 * Exported for testing.
 */
export async function findSubtitleFile(
  basePath: string,
  searchDir?: string,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const { dirname, basename } = await import('node:path');

  try {
    const dir = searchDir || dirname(basePath);
    const baseName = basename(basePath);
    const files = await readdir(dir);

    logger?.debug(
      {
        dir,
        baseName,
        subtitleFiles: files.filter((f) => f.endsWith('.srt') || f.endsWith('.vtt')),
      },
      'Searching for subtitle file'
    );

    // yt-dlp creates files in format: baseName.language.srt or baseName.language.vtt
    // For example: subtitles_VIDEO_ID_TIMESTAMP_auto.en.srt
    // Search for files with .srt or .vtt extensions that start with baseName
    const subtitleFile = files.find((file) => {
      const startsWithBase = file.startsWith(baseName);
      const hasSubtitleExt = file.endsWith('.srt') || file.endsWith('.vtt');
      return startsWithBase && hasSubtitleExt;
    });

    // If exact match not found, try to find files that contain baseName
    // (in case the name format is slightly different)
    let resultPath: string | null = null;
    if (subtitleFile) {
      resultPath = join(dir, subtitleFile);
    } else {
      const alternativeFile = files.find((file) => {
        const hasSubtitleExt = file.endsWith('.srt') || file.endsWith('.vtt');
        const containsBaseName = file.includes(baseName);
        return hasSubtitleExt && containsBaseName;
      });
      if (alternativeFile) {
        resultPath = join(dir, alternativeFile);
      }
    }

    logger?.debug({ baseName, dir, found: resultPath }, 'Subtitle file search result');

    return resultPath;
  } catch (error) {
    logger?.error({ error, basePath }, 'Error finding subtitle file');
    return null;
  }
}

// Exported for testing.
export function getYtDlpEnv() {
  return {
    jsRuntimes: process.env.YT_DLP_JS_RUNTIMES?.trim(),
    remoteComponents: process.env.YT_DLP_REMOTE_COMPONENTS?.trim() || 'ejs:github',
    cookiesFilePathFromEnv: process.env.COOKIES_FILE_PATH?.trim(),
  };
}

// Exported for testing.
export function appendYtDlpEnvArgs(
  args: string[],
  env: { jsRuntimes?: string; remoteComponents?: string; cookiesFilePathFromEnv?: string }
) {
  if (env.cookiesFilePathFromEnv) {
    args.splice(-1, 0, '--cookies', env.cookiesFilePathFromEnv);
  }

  if (env.jsRuntimes) {
    args.splice(-1, 0, '--js-runtimes', env.jsRuntimes);
  }

  if (env.remoteComponents) {
    args.splice(-1, 0, '--remote-components', env.remoteComponents);
  }
}

// Exported for testing.
export async function fetchYtDlpJson(
  videoId: string,
  logger?: FastifyBaseLogger
): Promise<YtDlpVideoInfo | null> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv } = getYtDlpEnv();

  const args = ['--dump-single-json', '--skip-download', videoUrl];
  appendYtDlpEnvArgs(args, { jsRuntimes, remoteComponents, cookiesFilePathFromEnv });

  try {
    const timeout = process.env.YT_DLP_TIMEOUT
      ? Number.parseInt(process.env.YT_DLP_TIMEOUT, 10)
      : 60000;
    const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    if (stderr) {
      logger?.debug({ stderr }, 'yt-dlp stderr');
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as YtDlpVideoInfo;
    } catch (parseError) {
      logger?.error(
        {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          videoId,
          stdoutPreview: trimmed.slice(0, 200),
        },
        'Error parsing yt-dlp JSON output'
      );
      return null;
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const execErr = isExecFileException(error) ? error : null;
    logger?.error(
      {
        error: err.message,
        videoId,
        ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
      },
      'Error fetching video info via yt-dlp'
    );
    return null;
  }
}

/**
 * Detects subtitle format by content
 * @param content - subtitle file content
 * @returns 'vtt' if format is VTT, otherwise 'srt'
 */
export function detectSubtitleFormat(content: string): 'srt' | 'vtt' {
  return content.startsWith('WEBVTT') ? 'vtt' : 'srt';
}

/**
 * Parses subtitles (SRT or VTT) and returns plain text without timestamps
 * @param content - subtitle content
 * @param logger - Fastify logger instance for structured logging
 */
export function parseSubtitles(content: string, logger?: FastifyBaseLogger): string {
  const format = detectSubtitleFormat(content);

  switch (format) {
    case 'vtt':
      return parseVTT(content, logger);
    case 'srt':
      return parseSRT(content, logger);
    default:
      throw new Error(`Unsupported subtitle format: ${format}`);
  }
}

/**
 * Cleans subtitle line from formatting and service elements
 */
function cleanSubtitleLine(line: string): string {
  let cleanLine = line;

  // Remove HTML tags
  cleanLine = cleanLine.replace(/<[^>]+>/g, '');

  // Remove speaker markers (>>)
  cleanLine = cleanLine.replace(/^>>\s*/g, '').replace(/\s*>>\s*/g, ' ');

  // Remove sound labels in square brackets: [music], [applause], [laughter], etc.
  cleanLine = cleanLine.replace(/\[[^\]]+\]/g, '');

  // Remove VTT cue settings
  cleanLine = cleanLine.replace(/::cue\([^)]+\)\s*\{[^}]*\}/g, '');

  // Remove multiple spaces
  cleanLine = cleanLine.replace(/\s+/g, ' ').trim();

  return cleanLine;
}

/**
 * Parses SRT format
 * @param content - SRT subtitle content
 * @param logger - Fastify logger instance for structured logging
 */
function parseSRT(content: string, logger?: FastifyBaseLogger): string {
  logger?.debug('Parsing SRT content');
  const lines = content.split('\n');
  const textLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines and numbers
    if (line === '' || /^\d+$/.test(line)) {
      i++;
      continue;
    }

    // Skip timestamps (format: 00:00:00,000 --> 00:00:00,000)
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line)) {
      i++;
      continue;
    }

    // This is subtitle text
    if (line.length > 0) {
      let cleanLine = cleanSubtitleLine(line);

      // Remove index numbers: numbers at the beginning of line followed by space
      cleanLine = cleanLine.replace(/^\d+\s+/g, '');

      // Remove index numbers that stand alone between words
      // Pattern: space, number, space (but not numbers that are part of words or phrases)
      cleanLine = cleanLine.replace(/\s+\d+\s+/g, ' ');

      // Remove numbers at the end of line before space (if it's an index)
      cleanLine = cleanLine.replace(/\s+\d+$/g, '');

      // Final space cleanup
      cleanLine = cleanLine.replace(/\s+/g, ' ').trim();

      if (cleanLine.length > 0) {
        textLines.push(cleanLine);
      }
    }

    i++;
  }

  return textLines.join(' ');
}

/**
 * Parses VTT format
 * @param content - VTT subtitle content
 * @param logger - Fastify logger instance for structured logging
 */
function parseVTT(content: string, logger?: FastifyBaseLogger): string {
  logger?.debug('Parsing VTT content');
  const lines = content.split('\n');
  const textLines: string[] = [];
  let i = 0;

  // Skip WEBVTT header and metadata
  while (
    i < lines.length &&
    (lines[i].startsWith('WEBVTT') || lines[i].startsWith('NOTE') || lines[i].trim() === '')
  ) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines
    if (line === '') {
      i++;
      continue;
    }

    // Skip timestamps (format: 00:00:00.000 --> 00:00:00.000)
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line)) {
      i++;
      continue;
    }

    // Skip styles and settings
    if (line.startsWith('STYLE') || line.startsWith('::cue') || line.startsWith('NOTE')) {
      i++;
      continue;
    }

    // This is subtitle text
    if (line.length > 0) {
      const cleanLine = cleanSubtitleLine(line);

      if (cleanLine.length > 0) {
        textLines.push(cleanLine);
      }
    }

    i++;
  }

  return textLines.join(' ');
}
