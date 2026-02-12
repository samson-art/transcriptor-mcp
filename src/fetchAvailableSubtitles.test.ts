import { execFile } from 'node:child_process';

import { fetchAvailableSubtitles } from './youtube.js';

jest.mock('node:child_process');

describe('fetchAvailableSubtitles', () => {
  it('should return sorted lists of official and auto subtitles from yt-dlp JSON', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    const ytDlpJson = {
      subtitles: {
        ru: [{ ext: 'vtt', url: 'https://example.com/ru.vtt' }],
        en: [{ ext: 'vtt', url: 'https://example.com/en.vtt' }],
      },
      automatic_captions: {
        de: [{ ext: 'vtt', url: 'https://example.com/de.vtt' }],
        en: [{ ext: 'vtt', url: 'https://example.com/en-auto.vtt' }],
      },
    };

    const mockedExecFile = execFile as unknown as jest.Mock;

    mockedExecFile.mockImplementation(
      (
        _file: string,
        _args: string[] | null | undefined,
        _options: import('node:child_process').ExecFileOptions | null | undefined,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        callback(null, {
          stdout: JSON.stringify(ytDlpJson),
          stderr: '',
        });
      }
    );

    const result = await fetchAvailableSubtitles(url);

    expect(result).toEqual({
      official: ['en', 'ru'],
      auto: ['de', 'en'],
    });
  });
});
