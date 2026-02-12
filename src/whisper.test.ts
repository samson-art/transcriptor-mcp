import * as fsPromises from 'node:fs/promises';
import { getWhisperConfig, transcribeWithWhisper } from './whisper.js';
import * as youtube from './youtube.js';

const originalEnv = process.env;
const originalFetch = globalThis.fetch;

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake-audio')),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  jest.restoreAllMocks();
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
});

describe('getWhisperConfig', () => {
  it('should return mode off when WHISPER_MODE is unset', () => {
    delete process.env.WHISPER_MODE;
    expect(getWhisperConfig().mode).toBe('off');
  });

  it('should return mode off when WHISPER_MODE is invalid', () => {
    process.env.WHISPER_MODE = 'invalid';
    expect(getWhisperConfig().mode).toBe('off');
  });

  it('should return mode local when WHISPER_MODE=local', () => {
    process.env.WHISPER_MODE = 'local';
    process.env.WHISPER_BASE_URL = 'http://whisper:9000';
    const config = getWhisperConfig();
    expect(config.mode).toBe('local');
    expect(config.baseUrl).toBe('http://whisper:9000');
  });

  it('should return mode api when WHISPER_MODE=api', () => {
    process.env.WHISPER_MODE = 'api';
    process.env.WHISPER_API_KEY = 'sk-test';
    const config = getWhisperConfig();
    expect(config.mode).toBe('api');
    expect(config.apiKey).toBe('sk-test');
  });

  it('should use default timeout when WHISPER_TIMEOUT unset', () => {
    expect(getWhisperConfig().timeout).toBe(120_000);
  });

  it('should use WHISPER_TIMEOUT when set', () => {
    process.env.WHISPER_TIMEOUT = '60000';
    expect(getWhisperConfig().timeout).toBe(60_000);
  });

  it('should use default API base URL when unset', () => {
    expect(getWhisperConfig().apiBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('should strip trailing slash from API base URL', () => {
    process.env.WHISPER_API_BASE_URL = 'https://custom.example.com/v1/';
    expect(getWhisperConfig().apiBaseUrl).toBe('https://custom.example.com/v1');
  });
});

describe('transcribeWithWhisper', () => {
  it('should return null when mode is off', async () => {
    process.env.WHISPER_MODE = 'off';
    const downloadSpy = jest.spyOn(youtube, 'downloadAudio').mockResolvedValue('/tmp/audio.m4a');
    const result = await transcribeWithWhisper(
      'https://www.youtube.com/watch?v=video123',
      'en',
      'srt'
    );
    expect(result).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('should return null when downloadAudio fails', async () => {
    process.env.WHISPER_MODE = 'local';
    process.env.WHISPER_BASE_URL = 'http://whisper:9000';
    jest.spyOn(youtube, 'downloadAudio').mockResolvedValue(null);
    const result = await transcribeWithWhisper(
      'https://www.youtube.com/watch?v=video123',
      'en',
      'srt'
    );
    expect(result).toBeNull();
  });

  it('should call local /asr with audio_file and query params output and language', async () => {
    process.env.WHISPER_MODE = 'local';
    process.env.WHISPER_BASE_URL = 'http://whisper:9000';
    jest.spyOn(youtube, 'downloadAudio').mockResolvedValue('/tmp/audio.m4a');
    (fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from('fake-audio'));
    (fsPromises.unlink as jest.Mock).mockResolvedValue(undefined);

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('1\n00:00:00,000 --> 00:00:01,000\nHello'),
    });
    globalThis.fetch = fetchMock;

    const result = await transcribeWithWhisper('https://www.instagram.com/reels/abc/', 'en', 'srt');

    expect(result).toBe('1\n00:00:00,000 --> 00:00:01,000\nHello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('http://whisper:9000/asr?');
    expect(url).toContain('output=srt');
    expect(url).toContain('language=en');
    const formData = options.body as FormData;
    expect(formData).toBeInstanceOf(FormData);
    const keys = [...formData.entries()].map(([k]) => k);
    expect(keys).toEqual(['audio_file']);
  });

  it('should map text format to output=txt for local /asr', async () => {
    process.env.WHISPER_MODE = 'local';
    process.env.WHISPER_BASE_URL = 'http://whisper:9000';
    jest.spyOn(youtube, 'downloadAudio').mockResolvedValue('/tmp/audio.m4a');
    (fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from('fake'));
    (fsPromises.unlink as jest.Mock).mockResolvedValue(undefined);

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('Hi') });
    globalThis.fetch = fetchMock;

    await transcribeWithWhisper('https://example.com/v', 'ru', 'text');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('output=txt');
    expect(url).toContain('language=ru');
  });

  it('should not add language param when lang is empty (auto-detect)', async () => {
    process.env.WHISPER_MODE = 'local';
    process.env.WHISPER_BASE_URL = 'http://whisper:9000';
    jest.spyOn(youtube, 'downloadAudio').mockResolvedValue('/tmp/audio.m4a');
    (fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from('fake'));
    (fsPromises.unlink as jest.Mock).mockResolvedValue(undefined);

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('1\n00:00:00,000 --> 00:00:01,000\nDetected'),
    });
    globalThis.fetch = fetchMock;

    await transcribeWithWhisper('https://example.com/v', '', 'srt');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('http://whisper:9000/asr?');
    expect(url).toContain('output=srt');
    expect(url).not.toContain('language=');
  });
});
