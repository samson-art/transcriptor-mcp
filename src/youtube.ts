import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFile, readFile, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';

import { parseIntEnv } from './env.js';

const execFileAsync = promisify(execFile);

/** Builds a safe base name for temp files from URL (hash + timestamp). Exported for tests. */
export function urlToSafeBase(url: string, prefix: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return `${prefix}_${hash}_${Date.now()}`;
}

function isExecFileException(error: unknown): error is ExecFileException {
  return error instanceof Error && (error as ExecFileException).code !== undefined;
}

/** Fields from a failed yt-dlp exec for logging and MCP error messages. Exported for tests and callers. */
export type ExecFileErrorDetails = {
  message: string;
  exitCode?: number | string;
  signal?: string;
  cmd?: string;
  stdout?: string;
  stderr?: string;
};

export function collectExecFileErrorDetails(error: unknown): ExecFileErrorDetails {
  const err = error instanceof Error ? error : new Error(String(error));
  const execErr = isExecFileException(error) ? error : null;
  const details: ExecFileErrorDetails = { message: err.message };
  if (!execErr) {
    return details;
  }
  if (execErr.code !== undefined && execErr.code !== null) {
    details.exitCode = execErr.code;
  }
  if (execErr.signal) {
    details.signal = execErr.signal;
  }
  if (execErr.cmd) {
    details.cmd = execErr.cmd;
  }
  if (typeof execErr.stdout === 'string' && execErr.stdout.length > 0) {
    details.stdout = execErr.stdout;
  }
  if (typeof execErr.stderr === 'string' && execErr.stderr.length > 0) {
    details.stderr = execErr.stderr;
  }
  return details;
}

type YtDlpChapter = {
  start_time?: number;
  end_time?: number;
  title?: string;
};

export type YtDlpVideoInfo = {
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
 * Extracts YouTube video ID from a URL.
 * Used as a fallback for display/logging when yt-dlp does not return an id.
 * Only supports YouTube URLs; returns null for other platforms (TikTok, Vimeo, etc.).
 */
export function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = new RegExp(pattern).exec(url);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/** @deprecated Use extractYouTubeVideoId. Kept for backward compatibility. */
export const extractVideoId = extractYouTubeVideoId;

/** Supported subtitle formats for yt-dlp and output. */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'lrc';

const SUBTITLE_EXTENSIONS = new Set<SubtitleFormat>(['srt', 'vtt', 'ass', 'lrc']);

const SUB_EXTENSIONS = ['.srt', '.vtt', '.ass', '.lrc'] as const;

/** Resolves subtitle format: param/env overrides, default srt. */
export function resolveSubtitleFormat(formatParam?: SubtitleFormat | null): SubtitleFormat {
  const fromParam =
    formatParam ?? (process.env.YT_DLP_SUB_FORMAT?.trim() as SubtitleFormat | undefined);
  if (fromParam && SUBTITLE_EXTENSIONS.has(fromParam)) {
    return fromParam;
  }
  return 'srt';
}

/** Builds --sub-format and optionally --convert-subs args for yt-dlp. */
function buildSubFormatArgs(format: SubtitleFormat): string[] {
  const args: string[] = [];
  args.push('--sub-format', format === 'lrc' ? 'best' : format);
  if (format === 'lrc') {
    args.push('--convert-subs', 'lrc');
  }
  return args;
}

async function readAndReturnSubtitleIfValid(subtitleFile: string | null): Promise<string | null> {
  if (!subtitleFile) return null;
  const content = await readFile(subtitleFile, 'utf-8');
  if (content.trim().length <= 0) return null;
  await unlink(subtitleFile).catch(() => {});
  return content;
}

async function runYtDlpAndExtractSubtitles(
  args: string[],
  outputPath: string,
  tempDir: string,
  subFormat: SubtitleFormat,
  type: 'official' | 'auto',
  lang: string,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  try {
    const timeout = parseIntEnv('YT_DLP_TIMEOUT', 60000);
    const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    logger?.debug({ stdout }, 'yt-dlp stdout');
    if (stderr) logger?.debug({ stderr }, 'yt-dlp stderr');

    await new Promise((resolve) => setTimeout(resolve, 100));

    const subtitleFile = await findSubtitleFile(outputPath, tempDir, subFormat, logger);
    return await readAndReturnSubtitleIfValid(subtitleFile);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const execErr = isExecFileException(error) ? error : null;
    logger?.error(
      {
        error: err.message,
        type,
        lang,
        ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
      },
      `Error downloading ${type} subtitles`
    );

    logger?.debug('Checking for subtitle file despite error...');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const subtitleFile = await findSubtitleFile(outputPath, tempDir, subFormat, logger);
    logger?.debug({ subtitleFile }, 'subtitleFile found after error');

    if (subtitleFile) {
      try {
        return await readAndReturnSubtitleIfValid(subtitleFile);
      } catch (readError) {
        logger?.error({ error: readError, subtitleFile }, 'Error reading subtitle file');
      }
    }
    return null;
  }
}

/**
 * Downloads subtitles using yt-dlp
 * @param url - Video URL (any supported platform)
 * @param type - subtitle type: 'official' or 'auto'
 * @param lang - subtitle language (e.g., 'en', 'ru')
 * @param format - subtitle format: srt, vtt, ass, lrc (default from YT_DLP_SUB_FORMAT or srt)
 * @param logger - Fastify logger instance for structured logging
 */
export async function downloadSubtitles(
  url: string,
  type: 'official' | 'auto' = 'auto',
  lang: string = 'en',
  format?: SubtitleFormat | null,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const subFormat = resolveSubtitleFormat(format);
  const tempDir = tmpdir();
  const outputPath = join(tempDir, urlToSafeBase(url, 'subtitles'));
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv } = getYtDlpEnv();

  let cookiesPathToUse = cookiesFilePathFromEnv;
  let cookiesCleanup: (() => Promise<void>) | undefined;
  if (cookiesFilePathFromEnv) {
    const resolved = await ensureWritableCookiesFile(cookiesFilePathFromEnv);
    cookiesPathToUse = resolved.path;
    cookiesCleanup = resolved.cleanup;
  }

  try {
    await logCookiesFileStatus(logger, cookiesFilePathFromEnv);
    const subFlag = type === 'official' ? '--write-subs' : '--write-auto-subs';
    const baseArgs = [
      subFlag,
      '--skip-download',
      '--sub-lang',
      lang,
      ...buildSubFormatArgs(subFormat),
      '--output',
      `${outputPath}.%(ext)s`,
      '--no-playlist',
    ];
    const optionalArgs: string[] = [];
    appendYtDlpEnvArgs(optionalArgs, {
      jsRuntimes,
      remoteComponents,
      cookiesFilePathFromEnv: cookiesPathToUse,
    });
    appendYtDlpSubtitleArgs(optionalArgs);
    const args = [...baseArgs, ...optionalArgs, url];

    logger?.info(
      { type, lang, format: subFormat, hasCookies: Boolean(cookiesFilePathFromEnv) },
      `Downloading ${type} subtitles in language ${lang}`
    );

    return await runYtDlpAndExtractSubtitles(
      args,
      outputPath,
      tempDir,
      subFormat,
      type,
      lang,
      logger
    );
  } catch (error) {
    logger?.error({ error }, 'Error downloading subtitles');
    return null;
  } finally {
    await cookiesCleanup?.();
  }
}

export type PlaylistSubtitlesResult = {
  videoId: string;
  content: string;
};

export type DownloadPlaylistSubtitlesOutcome =
  | { ok: true; results: PlaylistSubtitlesResult[] }
  | { ok: false; failure: ExecFileErrorDetails };

/** User-facing message for MCP/HTTP when playlist subtitle download fails completely. */
export function formatPlaylistDownloadFailureMessage(f: ExecFileErrorDetails): string {
  const parts: string[] = [f.message];
  if (f.exitCode !== undefined) {
    parts.push(`exit code: ${String(f.exitCode)}`);
  }
  if (f.signal) {
    parts.push(`signal: ${f.signal}`);
  }
  const errTail = f.stderr?.trim();
  if (errTail) {
    const clipped = errTail.length > 4000 ? `${errTail.slice(0, 4000)}…` : errTail;
    parts.push(`stderr: ${clipped}`);
  }
  return `${parts.join(' | ')} If this persists, refresh COOKIES_FILE_PATH, run yt-dlp -U, or set YT_DLP_VERBOSE_ON_ERROR=1 for diagnostics.`;
}

/** Options for downloadPlaylistSubtitles */
export type DownloadPlaylistSubtitlesOptions = {
  type?: 'official' | 'auto';
  lang?: string;
  /** Subtitle format: srt, vtt, ass, lrc (default from YT_DLP_SUB_FORMAT or srt) */
  format?: SubtitleFormat | null;
  /** yt-dlp -I/--playlist-items, e.g. "1:5", "1,3,7", "-1" */
  playlistItems?: string;
  /** yt-dlp --max-downloads */
  maxItems?: number;
};

function buildPlaylistDownloadArgs(opts: {
  type: 'official' | 'auto';
  lang: string;
  subFormat: SubtitleFormat;
  outputTemplate: string;
  playlistItems?: string;
  maxItems?: number;
  url: string;
}): string[] {
  const subFlag = opts.type === 'official' ? '--write-subs' : '--write-auto-subs';
  const args = [
    subFlag,
    '--skip-download',
    '--sub-lang',
    opts.lang,
    ...buildSubFormatArgs(opts.subFormat),
    '--output',
    opts.outputTemplate,
    '--yes-playlist',
  ];
  if (opts.playlistItems) {
    args.push('--playlist-items', opts.playlistItems);
  }
  if (opts.maxItems != null && opts.maxItems > 0) {
    args.push('--max-downloads', String(opts.maxItems));
  }
  const downloadArchive = process.env.YT_DLP_DOWNLOAD_ARCHIVE?.trim();
  if (downloadArchive) {
    args.push('--download-archive', downloadArchive, '--break-on-existing');
  }
  const ignoreErrors = process.env.YT_DLP_PLAYLIST_IGNORE_ERRORS?.trim();
  if (ignoreErrors !== '0') {
    args.push('--ignore-errors');
  }
  return args;
}

function parseSubtitleFilename(file: string): { videoId: string; ext: string } | null {
  const parts = file.split('.');
  if (parts.length < 3) return null;
  const ext = parts.pop()!.toLowerCase();
  parts.pop();
  const videoId = parts.join('.');
  const validExts = SUB_EXTENSIONS.map((e) => e.slice(1));
  if (!videoId || !validExts.includes(ext)) return null;
  return { videoId, ext };
}

async function collectSubtitleResults(
  subtitleFiles: string[],
  tempDir: string,
  logger?: FastifyBaseLogger
): Promise<PlaylistSubtitlesResult[]> {
  const results: PlaylistSubtitlesResult[] = [];
  for (const file of subtitleFiles) {
    const parsed = parseSubtitleFilename(file);
    if (!parsed) continue;
    const filePath = join(tempDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.trim().length > 0) {
        results.push({ videoId: parsed.videoId, content });
      }
    } catch (readErr) {
      logger?.warn({ file, error: readErr }, 'Failed to read subtitle file');
    }
    await unlink(filePath).catch(() => {});
  }
  return results;
}

function getExtendedTimeout(): number {
  const timeout = parseIntEnv('YT_DLP_TIMEOUT', 60000);
  return Math.max(timeout, 120000);
}

function execDetailsToLogFields(d: ExecFileErrorDetails): Record<string, unknown> {
  const out: Record<string, unknown> = { error: d.message };
  if (d.exitCode !== undefined) out.exitCode = d.exitCode;
  if (d.signal) out.signal = d.signal;
  if (d.cmd) out.cmd = d.cmd;
  if (d.stdout) out.stdout = d.stdout;
  if (d.stderr) out.stderr = d.stderr;
  return out;
}

async function runPlaylistVerboseReplay(
  buildFullArgs: (quiet: boolean, verbose: boolean) => string[],
  logger?: FastifyBaseLogger
): Promise<void> {
  if (process.env.YT_DLP_VERBOSE_ON_ERROR !== '1') {
    return;
  }
  try {
    const verboseArgs = buildFullArgs(false, true);
    await execFileAsync('yt-dlp', verboseArgs, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: getExtendedTimeout(),
    });
  } catch (replayErr: unknown) {
    const replayDetails = collectExecFileErrorDetails(replayErr);
    logger?.error(execDetailsToLogFields(replayDetails), 'yt-dlp playlist verbose replay stderr');
  }
}

async function handlePlaylistDownloadError(
  error: unknown,
  readResults: () => Promise<PlaylistSubtitlesResult[]>,
  buildFullArgs: (quiet: boolean, verbose: boolean) => string[],
  tempDir: string,
  logger?: FastifyBaseLogger
): Promise<DownloadPlaylistSubtitlesOutcome> {
  const details = collectExecFileErrorDetails(error);
  logger?.error(execDetailsToLogFields(details), 'Error downloading playlist subtitles');

  const partial = await readResults().catch(() => []);
  if (partial.length > 0) {
    logger?.warn(
      { count: partial.length, tempDir },
      'Returning partial playlist subtitle results after yt-dlp error'
    );
    return { ok: true, results: partial };
  }

  await runPlaylistVerboseReplay(buildFullArgs, logger);
  return { ok: false, failure: details };
}

/**
 * Downloads subtitles for multiple videos from a playlist using yt-dlp.
 * @param url - Playlist URL or watch URL with list= parameter
 * @param options - Optional type, lang, playlistItems, maxItems
 * @param logger - Fastify logger instance for structured logging
 * @returns Discriminated outcome: results on success or partial success; failure details if yt-dlp failed with no subtitle files
 */
export async function downloadPlaylistSubtitles(
  url: string,
  options: DownloadPlaylistSubtitlesOptions = {},
  logger?: FastifyBaseLogger
): Promise<DownloadPlaylistSubtitlesOutcome> {
  const { type = 'auto', lang = 'en', format, playlistItems, maxItems } = options;
  const subFormat = resolveSubtitleFormat(format);
  const tempDir = join(
    tmpdir(),
    `playlist_subs_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  const outputTemplate = join(tempDir, '%(id)s.%(ext)s');
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv } = getYtDlpEnv();

  let cookiesPathToUse = cookiesFilePathFromEnv;
  let cookiesCleanup: (() => Promise<void>) | undefined;
  if (cookiesFilePathFromEnv) {
    const resolved = await ensureWritableCookiesFile(cookiesFilePathFromEnv);
    cookiesPathToUse = resolved.path;
    cookiesCleanup = resolved.cleanup;
  }

  const { mkdir, readdir } = await import('node:fs/promises');

  const readPlaylistSubtitleResults = async (): Promise<PlaylistSubtitlesResult[]> => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const files = await readdir(tempDir);
    const subtitleFiles = files.filter((f) => SUB_EXTENSIONS.some((e) => f.endsWith(e)));
    return collectSubtitleResults(subtitleFiles, tempDir, logger);
  };

  try {
    await mkdir(tempDir, { recursive: true });
    await logCookiesFileStatus(logger, cookiesFilePathFromEnv);

    const baseArgs = buildPlaylistDownloadArgs({
      type,
      lang,
      subFormat,
      outputTemplate,
      playlistItems,
      maxItems,
      url,
    });

    const buildFullArgs = (quiet: boolean, verbose: boolean): string[] => {
      const optionalArgs: string[] = [];
      appendYtDlpEnvArgs(
        optionalArgs,
        {
          jsRuntimes,
          remoteComponents,
          cookiesFilePathFromEnv: cookiesPathToUse,
        },
        { quiet }
      );
      if (verbose) {
        optionalArgs.push('-v');
      }
      appendYtDlpSubtitleArgs(optionalArgs);
      return [...baseArgs, ...optionalArgs, url];
    };

    try {
      const args = buildFullArgs(true, false);

      logger?.info(
        {
          type,
          lang,
          format: subFormat,
          playlistItems,
          maxItems,
          hasCookies: Boolean(cookiesFilePathFromEnv),
        },
        'Downloading playlist subtitles via yt-dlp'
      );

      await execFileAsync('yt-dlp', args, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: getExtendedTimeout(),
      });
      logger?.debug({ tempDir }, 'yt-dlp playlist subtitles completed');

      const results = await readPlaylistSubtitleResults();
      return { ok: true, results };
    } catch (error: unknown) {
      return handlePlaylistDownloadError(
        error,
        readPlaylistSubtitleResults,
        buildFullArgs,
        tempDir,
        logger
      );
    }
  } catch (outerError: unknown) {
    const details = collectExecFileErrorDetails(outerError);
    logger?.error(execDetailsToLogFields(details), 'Error preparing playlist subtitle download');
    return { ok: false, failure: details };
  } finally {
    await cookiesCleanup?.();
    const { rm } = await import('node:fs/promises');
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fetchVideoInfo(
  url: string,
  logger?: FastifyBaseLogger
): Promise<VideoInfo | null> {
  const data = await fetchYtDlpJson(url, logger);
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
 * Fetches chapter markers (start/end time, title) for a video via yt-dlp.
 * When preFetchedData is provided, skips the network call and uses it instead.
 */
export async function fetchVideoChapters(
  url: string,
  logger?: FastifyBaseLogger,
  preFetchedData?: YtDlpVideoInfo | null
): Promise<VideoChapter[] | null> {
  const data = preFetchedData === undefined ? await fetchYtDlpJson(url, logger) : preFetchedData;
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
  url: string,
  logger?: FastifyBaseLogger
): Promise<AvailableSubtitles | null> {
  const data = await fetchYtDlpJson(url, logger);
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
 * Downloads audio only for a video (for Whisper transcription).
 * Caller must unlink the returned file path when done.
 * @param url - Video URL (any supported platform)
 * @param logger - Fastify logger instance for structured logging
 * @returns path to the temporary audio file (e.g. .m4a), or null on failure
 */
export async function downloadAudio(
  url: string,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const tempDir = tmpdir();
  const outputBase = join(tempDir, urlToSafeBase(url, 'audio'));
  const outputTemplate = `${outputBase}.%(ext)s`;
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv, proxyFromEnv } = getYtDlpEnv();

  let cookiesPathToUse = cookiesFilePathFromEnv;
  let cookiesCleanup: (() => Promise<void>) | undefined;
  if (cookiesFilePathFromEnv) {
    const resolved = await ensureWritableCookiesFile(cookiesFilePathFromEnv);
    cookiesPathToUse = resolved.path;
    cookiesCleanup = resolved.cleanup;
  }

  const audioFormat =
    (process.env.YT_DLP_AUDIO_FORMAT ?? '').trim() || 'bestaudio[abr<=192]/bestaudio';
  const audioQualityNum = parseIntEnv('YT_DLP_AUDIO_QUALITY', 5);
  const audioQuality = audioQualityNum < 0 || audioQualityNum > 9 ? '5' : String(audioQualityNum);

  const baseArgs = [
    '-f',
    audioFormat,
    '--extract-audio',
    '--audio-format',
    'm4a',
    '--audio-quality',
    audioQuality,
    '--output',
    outputTemplate,
    '--no-playlist',
  ];
  const optionalArgs: string[] = [];
  const maxFilesize = process.env.YT_DLP_MAX_FILESIZE?.trim();
  if (maxFilesize) {
    optionalArgs.push('--max-filesize', maxFilesize);
  }
  appendYtDlpEnvArgs(optionalArgs, {
    jsRuntimes,
    remoteComponents,
    cookiesFilePathFromEnv: cookiesPathToUse,
    proxyFromEnv,
  });
  appendYtDlpAudioArgs(optionalArgs);
  const args = [...baseArgs, ...optionalArgs, url];

  try {
    await logCookiesFileStatus(logger, cookiesFilePathFromEnv);
    const timeout = parseIntEnv('YT_DLP_AUDIO_TIMEOUT', parseIntEnv('YT_DLP_TIMEOUT', 60000));
    logger?.info('Downloading audio for Whisper');
    await execFileAsync('yt-dlp', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { readdir } = await import('node:fs/promises');
    const baseName = outputBase.split(/[/\\]/).pop() ?? '';
    const files = await readdir(tempDir);
    const audioFile = files.find(
      (f) =>
        f.startsWith(baseName) && (f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.mp3'))
    );
    if (audioFile) {
      return join(tempDir, audioFile);
    }
    logger?.error({ tempDir }, 'Audio file not found after yt-dlp');
    return null;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const execErr = isExecFileException(error) ? error : null;
    logger?.error(
      {
        error: err.message,
        ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
      },
      'Error downloading audio via yt-dlp'
    );
    return null;
  } finally {
    await cookiesCleanup?.();
  }
}

function hasSubtitleExtension(file: string): boolean {
  return SUB_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * Finds subtitle file in the specified directory
 * yt-dlp creates files in format: baseName.language.ext (e.g. baseName.auto.en.srt)
 * @param format - preferred format; when set, looks for that extension first
 * @param logger - Fastify logger instance for structured logging
 *
 * Exported for testing.
 */
export async function findSubtitleFile(
  basePath: string,
  searchDir?: string,
  format?: SubtitleFormat,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const { dirname, basename } = await import('node:path');

  try {
    const dir = searchDir || dirname(basePath);
    const baseName = basename(basePath);
    const files = await readdir(dir);
    const extOrder = format
      ? [`.${format}`, ...SUB_EXTENSIONS.filter((e) => e !== `.${format}`)]
      : SUB_EXTENSIONS;

    logger?.debug(
      {
        dir,
        baseName,
        subtitleFiles: files.filter(hasSubtitleExtension),
      },
      'Searching for subtitle file'
    );

    const candidateFiles = files.filter(
      (file) => file.startsWith(baseName) && hasSubtitleExtension(file)
    );
    const subtitleFile =
      candidateFiles.find((file) => extOrder.some((ext) => file.endsWith(ext))) ??
      candidateFiles[0];

    let resultPath: string | null = subtitleFile ? join(dir, subtitleFile) : null;
    if (!resultPath) {
      const alternativeFile = files.find(
        (file) => hasSubtitleExtension(file) && file.includes(baseName)
      );
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
    proxyFromEnv: process.env.YT_DLP_PROXY?.trim() || undefined,
  };
}

async function logCookiesFileStatus(
  logger: FastifyBaseLogger | undefined,
  cookiesFilePathFromEnv: string | undefined
) {
  if (!logger || !cookiesFilePathFromEnv) return;

  try {
    const stats = await stat(cookiesFilePathFromEnv);
    logger.info(
      {
        cookiesFilePath: cookiesFilePathFromEnv,
        cookiesFileExists: true,
        cookiesFileSize: stats.size,
      },
      'yt-dlp cookies file status'
    );
  } catch (error) {
    logger.warn(
      {
        cookiesFilePath: cookiesFilePathFromEnv,
        error: error instanceof Error ? error.message : String(error),
      },
      'yt-dlp cookies file not accessible'
    );
  }
}

/**
 * Returns a writable path for the cookies file. yt-dlp reads and writes cookies;
 * if the original file is read-only (e.g. Docker volume), it fails on save.
 * Copies to a temp writable location when the original is not writable.
 * Exported for testing.
 */
export async function ensureWritableCookiesFile(
  originalPath: string
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const { access } = await import('node:fs/promises');
  try {
    await access(originalPath, constants.R_OK | constants.W_OK);
    return { path: originalPath, cleanup: async () => {} };
  } catch {
    const tempPath = join(
      tmpdir(),
      `cookies_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
    );
    await copyFile(originalPath, tempPath);
    return {
      path: tempPath,
      cleanup: async () => {
        await unlink(tempPath).catch(() => {});
      },
    };
  }
}

/**
 * Appends yt-dlp env/options args to the given array.
 * Callers should build final args as: [...baseArgs, ...optionalArgs, url].
 *
 * @param out - Array to push options into (inserted before URL in final args)
 */
export type AppendYtDlpEnvArgsOptions = {
  /** When false, omit --no-progress and --quiet (e.g. verbose diagnostic replay). Default true. */
  quiet?: boolean;
};

// Exported for testing.
export function appendYtDlpEnvArgs(
  out: string[],
  env: {
    jsRuntimes?: string;
    remoteComponents?: string;
    cookiesFilePathFromEnv?: string;
    proxyFromEnv?: string;
  },
  opts?: AppendYtDlpEnvArgsOptions
) {
  if (opts?.quiet !== false) {
    out.push('--no-progress', '--quiet');
  }

  if (process.env.YT_DLP_NO_WARNINGS === '1') {
    out.push('--no-warnings');
  }

  if (env.cookiesFilePathFromEnv) {
    out.push('--cookies', env.cookiesFilePathFromEnv);
  }

  if (env.proxyFromEnv) {
    out.push('--proxy', env.proxyFromEnv);
  }

  if (env.jsRuntimes) {
    out.push('--js-runtimes', env.jsRuntimes);
  }

  if (env.remoteComponents) {
    out.push('--remote-components', env.remoteComponents);
  }

  const retries = process.env.YT_DLP_RETRIES?.trim();
  if (retries) {
    out.push('-R', retries);
  }

  const retrySleep = process.env.YT_DLP_RETRY_SLEEP?.trim();
  if (retrySleep) {
    out.push('--retry-sleep', retrySleep);
  }

  const sleepRequests = process.env.YT_DLP_SLEEP_REQUESTS?.trim();
  if (sleepRequests) {
    out.push('--sleep-requests', sleepRequests);
  }

  const sleepInterval = process.env.YT_DLP_SLEEP_INTERVAL?.trim();
  if (sleepInterval) {
    out.push('--sleep-interval', sleepInterval);
  }

  const maxSleepInterval = process.env.YT_DLP_MAX_SLEEP_INTERVAL?.trim();
  if (maxSleepInterval) {
    out.push('--max-sleep-interval', maxSleepInterval);
  }

  const sleepSubtitles = process.env.YT_DLP_SLEEP_SUBTITLES?.trim();
  if (sleepSubtitles) {
    out.push('--sleep-subtitles', sleepSubtitles);
  }

  const extraArgs = process.env.YT_DLP_EXTRA_ARGS?.trim();
  if (extraArgs) {
    const parts = extraArgs.split(/\s+/).filter((p) => p.length > 0);
    out.push(...parts);
  }
}

/**
 * Appends audio-specific yt-dlp args from env (for Whisper fallback).
 * Callers should build final args as: [...baseArgs, ...optionalArgs, url].
 * Exported for testing.
 */
export function appendYtDlpAudioArgs(out: string[]) {
  const frags = process.env.YT_DLP_AUDIO_CONCURRENT_FRAGMENTS?.trim();
  if (frags) {
    out.push('-N', frags);
  }
  const limitRate = process.env.YT_DLP_AUDIO_LIMIT_RATE?.trim();
  if (limitRate) {
    out.push('-r', limitRate);
  }
  const throttledRate = process.env.YT_DLP_AUDIO_THROTTLED_RATE?.trim();
  if (throttledRate) {
    out.push('--throttled-rate', throttledRate);
  }
  const retries = process.env.YT_DLP_AUDIO_RETRIES?.trim();
  if (retries) {
    out.push('-R', retries);
  }
  const fragmentRetries = process.env.YT_DLP_AUDIO_FRAGMENT_RETRIES?.trim();
  if (fragmentRetries) {
    out.push('--fragment-retries', fragmentRetries);
  }
  const retrySleep = process.env.YT_DLP_AUDIO_RETRY_SLEEP?.trim();
  if (retrySleep) {
    out.push('--retry-sleep', retrySleep);
  }
  const bufferSize = process.env.YT_DLP_AUDIO_BUFFER_SIZE?.trim();
  if (bufferSize) {
    out.push('--buffer-size', bufferSize);
  }
  const httpChunkSize = process.env.YT_DLP_AUDIO_HTTP_CHUNK_SIZE?.trim();
  if (httpChunkSize) {
    out.push('--http-chunk-size', httpChunkSize);
  }
  const downloader = process.env.YT_DLP_AUDIO_DOWNLOADER?.trim();
  if (downloader) {
    out.push('--downloader', downloader);
  }
  const downloaderArgs = process.env.YT_DLP_AUDIO_DOWNLOADER_ARGS?.trim();
  if (downloaderArgs) {
    out.push('--downloader-args', downloaderArgs);
  }
}

/**
 * Appends subtitle-specific yt-dlp args from env (encoding).
 * Callers should build final args as: [...baseArgs, ...optionalArgs, url].
 */
export function appendYtDlpSubtitleArgs(out: string[]) {
  const encoding = process.env.YT_DLP_ENCODING?.trim();
  if (encoding) {
    out.push('--encoding', encoding);
  }
}

export type SearchVideoResult = {
  videoId: string;
  title: string | null;
  url: string | null;
  duration: number | null;
  uploader: string | null;
  viewCount: number | null;
  thumbnail: string | null;
};

type YtDlpSearchEntry = {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  duration?: number;
  uploader?: string;
  view_count?: number;
  thumbnail?: string;
};

type YtDlpSearchResponse = {
  entries?: YtDlpSearchEntry[];
};

/** Options for searchVideos: offset for pagination, date filters, match filter. */
export type SearchVideosOptions = {
  offset?: number;
  /** yt-dlp --dateafter, e.g. "now-1week" or "20231201" */
  dateAfter?: string;
  /** yt-dlp --datebefore, e.g. "now-1year" or "20241201" */
  dateBefore?: string;
  /** yt-dlp --date, exact date e.g. "20231215" or "today-2weeks" */
  date?: string;
  /** yt-dlp --match-filter, e.g. "!is_live" or "duration < 3600 & like_count > 100" */
  matchFilter?: string;
};

function appendSearchOptionsArgs(args: string[], options?: SearchVideosOptions): void {
  if (options?.dateAfter) args.push('--dateafter', options.dateAfter);
  if (options?.dateBefore) args.push('--datebefore', options.dateBefore);
  if (options?.date) args.push('--date', options.date);
  if (options?.matchFilter) args.push('--match-filter', options.matchFilter);
  const ageLimit = process.env.YT_DLP_AGE_LIMIT?.trim();
  if (ageLimit) args.push('--age-limit', ageLimit);
}

function parseSearchResponse(
  trimmed: string,
  logger?: FastifyBaseLogger
): YtDlpSearchResponse | null {
  try {
    return JSON.parse(trimmed) as YtDlpSearchResponse;
  } catch (parseError) {
    logger?.error(
      {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        stdoutPreview: trimmed.slice(0, 200),
      },
      'Error parsing yt-dlp search JSON output'
    );
    return null;
  }
}

function mapSearchEntryToResult(e: YtDlpSearchEntry): SearchVideoResult {
  return {
    videoId: e.id ?? '',
    title: e.title ?? null,
    url: e.webpage_url ?? e.url ?? null,
    duration: typeof e.duration === 'number' ? e.duration : null,
    uploader: e.uploader ?? null,
    viewCount: typeof e.view_count === 'number' ? e.view_count : null,
    thumbnail: e.thumbnail ?? null,
  };
}

function getSearchErrorPayload(error: unknown): {
  message: string;
  stdout?: string;
  stderr?: string;
} {
  const err = error instanceof Error ? error : new Error(String(error));
  const execErr = isExecFileException(error) ? error : null;
  return {
    message: err.message,
    ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
  };
}

/**
 * Searches for videos on YouTube using yt-dlp (ytsearch).
 * @param query - Search query
 * @param limit - Max number of results to return (1-50, default 10)
 * @param logger - Fastify logger instance for structured logging
 * @param options - Optional offset (pagination), dateAfter, dateBefore, date, matchFilter
 * @returns Array of search results or null on error
 */
export async function searchVideos(
  query: string,
  limit: number = 10,
  logger?: FastifyBaseLogger,
  options?: SearchVideosOptions
): Promise<SearchVideoResult[] | null> {
  const sanitizedLimit = Math.min(Math.max(limit, 1), 50);
  const offset = Math.max(0, options?.offset ?? 0);
  const requestCount = Math.min(50, sanitizedLimit + offset);
  const searchUrl = `ytsearch${requestCount}:${query}`;
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv, proxyFromEnv } = getYtDlpEnv();

  let cookiesPathToUse = cookiesFilePathFromEnv;
  let cookiesCleanup: (() => Promise<void>) | undefined;
  if (cookiesFilePathFromEnv) {
    const resolved = await ensureWritableCookiesFile(cookiesFilePathFromEnv);
    cookiesPathToUse = resolved.path;
    cookiesCleanup = resolved.cleanup;
  }

  const baseArgs = ['--flat-playlist', '--dump-single-json', '--skip-download'];
  const optionalArgs: string[] = [];
  appendSearchOptionsArgs(optionalArgs, options);
  appendYtDlpEnvArgs(optionalArgs, {
    jsRuntimes,
    remoteComponents,
    cookiesFilePathFromEnv: cookiesPathToUse,
    proxyFromEnv,
  });
  const args = [...baseArgs, ...optionalArgs, searchUrl];

  try {
    await logCookiesFileStatus(logger, cookiesFilePathFromEnv);
    const timeout = parseIntEnv('YT_DLP_TIMEOUT', 60000);
    logger?.info(
      {
        query,
        limit: sanitizedLimit,
        offset,
        dateAfter: options?.dateAfter,
        dateBefore: options?.dateBefore,
        date: options?.date,
        matchFilter: options?.matchFilter,
      },
      'Searching videos via yt-dlp'
    );
    const { stdout, stderr } = await execFileAsync('yt-dlp', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    if (stderr) {
      logger?.debug({ stderr }, 'yt-dlp stderr');
    }

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    const data = parseSearchResponse(trimmed, logger);
    if (!data) return null;

    const entries = Array.isArray(data.entries) ? data.entries : [];
    const all = entries.filter((e): e is YtDlpSearchEntry => e != null).map(mapSearchEntryToResult);
    return all.slice(offset, offset + sanitizedLimit);
  } catch (error: unknown) {
    const { message, stdout, stderr } = getSearchErrorPayload(error);
    logger?.error(
      { error: message, ...(stdout !== undefined && { stdout, stderr }) },
      'Error searching videos via yt-dlp'
    );
    return null;
  } finally {
    await cookiesCleanup?.();
  }
}

// Exported for testing.
export async function fetchYtDlpJson(
  url: string,
  logger?: FastifyBaseLogger
): Promise<YtDlpVideoInfo | null> {
  const { jsRuntimes, remoteComponents, cookiesFilePathFromEnv } = getYtDlpEnv();

  let cookiesPathToUse = cookiesFilePathFromEnv;
  let cookiesCleanup: (() => Promise<void>) | undefined;
  if (cookiesFilePathFromEnv) {
    const resolved = await ensureWritableCookiesFile(cookiesFilePathFromEnv);
    cookiesPathToUse = resolved.path;
    cookiesCleanup = resolved.cleanup;
  }

  const baseArgs = ['--dump-single-json', '--skip-download', '--no-playlist'];
  const optionalArgs: string[] = [];
  if (process.env.YT_DLP_IGNORE_NO_FORMATS !== '0') {
    optionalArgs.push('--ignore-no-formats-error');
  }
  appendYtDlpEnvArgs(optionalArgs, {
    jsRuntimes,
    remoteComponents,
    cookiesFilePathFromEnv: cookiesPathToUse,
  });
  const args = [...baseArgs, ...optionalArgs, url];

  try {
    await logCookiesFileStatus(logger, cookiesFilePathFromEnv);
    const timeout = parseIntEnv('YT_DLP_TIMEOUT', 60000);
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
        ...(execErr && { stdout: execErr.stdout, stderr: execErr.stderr }),
      },
      'Error fetching video info via yt-dlp'
    );
    return null;
  } finally {
    await cookiesCleanup?.();
  }
}

/**
 * Detects subtitle format by content
 * @param content - subtitle file content
 * @returns detected format: srt, vtt, ass, or lrc
 */
export function detectSubtitleFormat(content: string): SubtitleFormat {
  const trimmed = content.trim();
  if (trimmed.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]|^\[V4\+ Styles\]|^\[Events\]/m.test(trimmed)) return 'ass';
  if (/^\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]/m.test(trimmed)) return 'lrc';
  return 'srt';
}

/**
 * Parses subtitles (SRT, VTT, ASS, or LRC) and returns plain text without timestamps
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
    case 'ass':
      return parseASS(content, logger);
    case 'lrc':
      return parseLRC(content, logger);
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
  cleanLine = cleanLine.replaceAll(/<[^>]+>/g, '');

  // Remove speaker markers (>>)
  cleanLine = cleanLine.replaceAll(/^>>\s*/g, '').replaceAll(/\s*>>\s*/g, ' ');

  // Remove sound labels in square brackets: [music], [applause], [laughter], etc.
  cleanLine = cleanLine.replaceAll(/\[[^\]]+\]/g, '');

  // Remove VTT cue settings
  cleanLine = cleanLine.replaceAll(/::cue\([^)]+\)\s*\{[^}]*\}/g, '');

  // Remove multiple spaces
  cleanLine = cleanLine.replaceAll(/\s+/g, ' ').trim();

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

      // Final space cleanup
      cleanLine = cleanLine.replaceAll(/\s+/g, ' ').trim();

      if (cleanLine.length > 0) {
        textLines.push(cleanLine);
      }
    }

    i++;
  }

  return textLines.join(' ');
}

const VTT_TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

function isVTTSkipLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('STYLE') || t.startsWith('::cue') || t.startsWith('NOTE');
}

function skipVTTHeader(lines: string[], start: number): number {
  let i = start;
  while (
    i < lines.length &&
    (lines[i].startsWith('WEBVTT') || lines[i].startsWith('NOTE') || lines[i].trim() === '')
  ) {
    i++;
  }
  return i;
}

function parseCueBlock(
  lines: string[],
  startIndex: number
): { cueText: string; nextIndex: number } {
  const cueLines: string[] = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '') {
      i++;
      continue;
    }
    if (VTT_TIMESTAMP_RE.test(l)) break;
    if (isVTTSkipLine(l)) {
      i++;
      continue;
    }
    const clean = cleanSubtitleLine(l);
    if (clean) cueLines.push(clean);
    i++;
  }
  const cueText = cueLines.join(' ').trim();
  return { cueText, nextIndex: i };
}

/**
 * Parses VTT format. Groups text by cue (timestamp block) and deduplicates
 * consecutive cues with identical text (word-by-word VTT format).
 * @param content - VTT subtitle content
 * @param logger - Fastify logger instance for structured logging
 */
function parseVTT(content: string, logger?: FastifyBaseLogger): string {
  logger?.debug('Parsing VTT content');
  const lines = content.split('\n');
  const textLines: string[] = [];
  let prevCueText = '';
  let i = skipVTTHeader(lines, 0);

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      i++;
      continue;
    }
    if (VTT_TIMESTAMP_RE.test(trimmed)) {
      const { cueText, nextIndex } = parseCueBlock(lines, i);
      if (cueText && cueText !== prevCueText) {
        textLines.push(cueText);
        prevCueText = cueText;
      }
      i = nextIndex;
      continue;
    }
    if (isVTTSkipLine(lines[i])) {
      i++;
      continue;
    }
    const clean = cleanSubtitleLine(trimmed);
    if (clean && clean !== prevCueText) {
      textLines.push(clean);
      prevCueText = clean;
    }
    i++;
  }

  return textLines.join(' ');
}

/** Extracts text from ASS Dialogue line (format: Dialogue: Layer,Start,End,...,Text) */
function extractDialogueText(dialogueLine: string): string {
  const afterPrefix = dialogueLine.slice('Dialogue:'.length);
  const parts = afterPrefix.split(',');
  const text = parts.slice(9).join(',');
  return text
    .replaceAll(String.raw`\N`, ' ')
    .replaceAll(String.raw`\n`, ' ')
    .trim();
}

/**
 * Parses ASS (Advanced SubStation Alpha) format - extracts Dialogue text
 */
function parseASS(content: string, logger?: FastifyBaseLogger): string {
  logger?.debug('Parsing ASS content');
  const lines = content.split('\n');
  const textLines: string[] = [];
  let inEvents = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[Events]')) {
      inEvents = true;
      continue;
    }
    if (!inEvents || !trimmed.startsWith('Dialogue:')) continue;

    const text = extractDialogueText(trimmed);
    const cleaned = cleanSubtitleLine(text);
    if (cleaned.length > 0) textLines.push(cleaned);
  }

  return textLines.join(' ');
}

/**
 * Parses LRC (lyrics) format - [mm:ss.xx] or [mm:ss] followed by text
 */
function parseLRC(content: string, logger?: FastifyBaseLogger): string {
  logger?.debug('Parsing LRC content');
  const lines = content.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const match = new RegExp(/^\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]\s*(.+)$/).exec(line);
    if (match?.[1]) {
      const cleaned = cleanSubtitleLine(match[1]);
      if (cleaned.length > 0) textLines.push(cleaned);
    }
  }

  return textLines.join(' ');
}
