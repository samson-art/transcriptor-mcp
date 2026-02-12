import { readFile, unlink } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { downloadAudio } from './youtube.js';

export type WhisperMode = 'off' | 'local' | 'api';

export type WhisperConfig = {
  mode: WhisperMode;
  baseUrl?: string;
  timeout: number;
  apiKey?: string;
  apiBaseUrl: string;
};

const DEFAULT_WHISPER_TIMEOUT = 120_000;
const OPENAI_API_BASE = 'https://api.openai.com/v1';

/**
 * Reads Whisper configuration from environment.
 * Exported for testing.
 */
export function getWhisperConfig(): WhisperConfig {
  const raw = process.env.WHISPER_MODE?.trim().toLowerCase();
  const mode: WhisperMode = raw === 'local' || raw === 'api' ? raw : 'off';

  const timeout = process.env.WHISPER_TIMEOUT
    ? Number.parseInt(process.env.WHISPER_TIMEOUT, 10)
    : DEFAULT_WHISPER_TIMEOUT;

  const apiBaseUrl = process.env.WHISPER_API_BASE_URL?.trim() || OPENAI_API_BASE;

  return {
    mode,
    baseUrl: process.env.WHISPER_BASE_URL?.trim(),
    timeout: Number.isFinite(timeout) ? timeout : DEFAULT_WHISPER_TIMEOUT,
    apiKey: process.env.WHISPER_API_KEY?.trim(),
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ''),
  };
}

export type WhisperResponseFormat = 'srt' | 'vtt' | 'text';

/** Maps internal response format to whisper-asr-webservice /asr output query param. */
function localOutputFormat(responseFormat: WhisperResponseFormat): string {
  return responseFormat === 'text' ? 'txt' : responseFormat;
}

/**
 * Transcribes audio using a local Whisper HTTP service (e.g. whisper-asr-webservice).
 * POST /asr with multipart field audio_file and query params: output, optional language.
 */
export async function transcribeWithWhisperLocal(
  audioPath: string,
  lang: string,
  responseFormat: WhisperResponseFormat,
  config: WhisperConfig,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  if (!config.baseUrl) {
    logger?.warn('WHISPER_BASE_URL is not set for local mode');
    return null;
  }

  const base = config.baseUrl.replace(/\/$/, '');
  const output = localOutputFormat(responseFormat);
  const searchParams = new URLSearchParams({ output });
  if (lang) {
    searchParams.set('language', lang);
  }
  const url = `${base}/asr?${searchParams.toString()}`;

  let body: FormData;
  try {
    const buffer = await readFile(audioPath);
    body = new FormData();
    body.append('audio_file', new Blob([buffer]), 'audio.m4a');
  } catch (err) {
    logger?.error({ err, audioPath }, 'Failed to read audio file for Whisper local');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const res = await fetch(url, {
      method: 'POST',
      body,
      signal: controller.signal,
      headers: {}, // FormData sets Content-Type with boundary
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      logger?.error(
        { status: res.status, statusText: res.statusText, url, body: errText.slice(0, 200) },
        'Whisper local request failed'
      );
      return null;
    }

    const text = await res.text();
    return text?.trim() ? text : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err: message, url }, 'Whisper local request error');
    return null;
  }
}

/**
 * Transcribes audio using OpenAI-compatible API (e.g. OpenAI Whisper).
 * POST /audio/transcriptions with multipart: file, model, response_format, optional language.
 */
export async function transcribeWithWhisperApi(
  audioPath: string,
  lang: string,
  responseFormat: WhisperResponseFormat,
  config: WhisperConfig,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  if (!config.apiKey) {
    logger?.warn('WHISPER_API_KEY is not set for api mode');
    return null;
  }

  const url = `${config.apiBaseUrl}/audio/transcriptions`;
  let body: FormData;
  try {
    const buffer = await readFile(audioPath);
    body = new FormData();
    body.append('file', new Blob([buffer]), 'audio.m4a');
    body.append('model', 'whisper-1');
    body.append('response_format', responseFormat);
    if (lang) {
      body.append('language', lang);
    }
  } catch (err) {
    logger?.error({ err, audioPath }, 'Failed to read audio file for Whisper API');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const res = await fetch(url, {
      method: 'POST',
      body,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      logger?.error(
        { status: res.status, statusText: res.statusText, body: errText.slice(0, 200) },
        'Whisper API request failed'
      );
      return null;
    }

    const text = await res.text();
    return text?.trim() ? text : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err: message }, 'Whisper API request error');
    return null;
  }
}

/**
 * Downloads video audio and transcribes with Whisper (local or api).
 * Returns SRT/VTT/text content or null. Caller does not need to unlink; this function cleans up the temp file.
 */
export async function transcribeWithWhisper(
  url: string,
  lang: string,
  responseFormat: WhisperResponseFormat,
  logger?: FastifyBaseLogger
): Promise<string | null> {
  const config = getWhisperConfig();
  if (config.mode === 'off') {
    return null;
  }

  const audioPath = await downloadAudio(url, logger);
  if (!audioPath) {
    return null;
  }

  try {
    let content: string | null;
    if (config.mode === 'local') {
      content = await transcribeWithWhisperLocal(audioPath, lang, responseFormat, config, logger);
    } else {
      content = await transcribeWithWhisperApi(audioPath, lang, responseFormat, config, logger);
    }
    return content;
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}
