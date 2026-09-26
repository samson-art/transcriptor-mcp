import { formatDuration, isYouTubePage, pageFromInput, watchUrlAt } from './format';
import { parseToolError, pickDefaultTrack, type AvailableSubtitleTracks } from './subtitleTracks';
import { videoInfoToMeta, type VideoInfoData } from './videoInfo';

const reel = 'https://www.instagram.com/reel/DdZsSYXxBqd/';

describe('watchUrlAt', () => {
  it('adds the time where the platform has a link for it', () => {
    expect(watchUrlAt('https://www.youtube.com/watch?v=abc', 83.9)).toBe(
      'https://www.youtube.com/watch?v=abc&t=83'
    );
    expect(watchUrlAt('https://youtu.be/abc', 83)).toBe('https://youtu.be/abc?t=83');
    expect(watchUrlAt('https://vimeo.com/123#old', 83)).toBe('https://vimeo.com/123#t=83s');
  });

  it('leaves a page without one as it is', () => {
    for (const page of [reel, 'https://notyoutube.com/watch?v=abc', 'DdZsSYXxBqd']) {
      expect(watchUrlAt(page, 83)).toBe(page);
    }
  });
});

describe('pages and ids', () => {
  it('reads a bare id as YouTube, as the server does, and a link as it is', () => {
    expect(pageFromInput('jNQXAC9IVRw')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(pageFromInput(reel)).toBe(reel);
  });

  it('knows a YouTube page by its host only', () => {
    expect(isYouTubePage('https://youtu.be/abc')).toBe(true);
    expect(isYouTubePage('https://m.youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubePage(reel)).toBe(false);
    expect(isYouTubePage('https://youtube.com.evil.example/watch?v=abc')).toBe(false);
    expect(isYouTubePage('DdZsSYXxBqd')).toBe(false);
  });
});

describe('formatDuration', () => {
  it('is empty for an unknown length, so no lone dash shows', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(62)).toBe('1:02');
  });
});

describe('pickDefaultTrack', () => {
  const none = { official: [], auto: [] };

  it('keeps a named speech-to-text transcript, so the widget reads its cache entry', () => {
    const whisper = { type: 'auto', lang: 'en' } as const;
    expect(pickDefaultTrack(none, whisper)).toEqual(whisper);
  });

  it('names nothing when neither the video nor the transcript has a language', () => {
    expect(pickDefaultTrack(none, { type: 'auto', lang: '' })).toBeNull();
    expect(pickDefaultTrack(none, null)).toBeNull();
  });

  it.each<[AvailableSubtitleTracks, 'official' | 'auto', string]>([
    // A lone -orig track names the original language, and its official track comes first (#54).
    [{ official: ['ar'], auto: ['ar', 'en', 'en-orig'] }, 'auto', 'en-orig'],
    [{ official: ['ar', 'en'], auto: ['en', 'en-orig'] }, 'official', 'en'],
    // Where the server would ask the caller: English first, then the first track.
    [{ official: ['ar', 'en_US'], auto: [] }, 'official', 'en_US'],
    [{ official: ['de', 'fr'], auto: [] }, 'official', 'de'],
    // Several -orig tracks on a dubbed video name no original language.
    [{ official: ['ar', 'en'], auto: ['ar-orig', 'de-orig', 'en-orig'] }, 'official', 'en'],
    [{ official: [], auto: ['ar-orig', 'es-orig'] }, 'auto', 'ar-orig'],
    // A guess takes the -orig name of a speech track, as the server does: on YouTube a plain
    // code also gathers translations into that language from every dubbed audio track.
    [
      { official: [], auto: ['ar', 'ar-orig', 'en', 'en-orig', 'es', 'es-orig'] },
      'auto',
      'en-orig',
    ],
    [{ official: [], auto: ['ar', 'ar-orig', 'es', 'es-orig'] }, 'auto', 'ar-orig'],
  ])('picks from %j the %s track %s', (available, type, lang) => {
    expect(pickDefaultTrack(available)).toEqual({ type, lang });
  });
});

describe('videoInfoToMeta', () => {
  const info: VideoInfoData = {
    videoId: 'DdZsSYXxBqd',
    title: 'Video by kateinamerica',
    uploader: null,
    channel: 'kateinamerica',
    duration: null,
    webpageUrl: reel,
    viewCount: null,
    thumbnail: null,
  };

  it('never makes up a YouTube thumbnail for an id', () => {
    const meta = videoInfoToMeta(info);
    expect(meta).toMatchObject({ thumbnail: null, url: reel, uploader: 'kateinamerica' });
  });

  it('upgrades an http thumbnail, which the https widget could not load', () => {
    const meta = videoInfoToMeta({ ...info, thumbnail: 'http://i2.hdslb.com/bfs/a.jpg' });
    expect(meta.thumbnail).toBe('https://i2.hdslb.com/bfs/a.jpg');
  });
});

describe('parseToolError', () => {
  const failed = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
  const listAnswer =
    'The platform does not say which language the video is spoken in, and it lists more than one track. To try a track auto-discovery skipped, pass type and lang explicitly.';

  it('gives the text of a failed call', () => {
    const text =
      'The platform lists no subtitle tracks for this video, so no type or lang will work. Do not repeat the same call.';
    expect(parseToolError(failed(text))).toEqual({ message: text, tracks: [] });
  });

  it('splits the listed tracks off the text of a track-list answer', () => {
    // The sentence as trackHint in src/mcp-core.ts writes it, for a TikTok video.
    const text = `${listAnswer} Available tracks — official: none; auto: eng-US, rus-RU.`;
    expect(parseToolError(failed(text))).toEqual({
      message: listAnswer,
      tracks: [{ type: 'auto', langs: ['eng-US', 'rus-RU'], more: 0 }],
    });
  });

  it('counts the tracks the answer left out', () => {
    const official = Array.from({ length: 15 }, (_, i) => `l${i}`);
    const text = `${listAnswer} Available tracks — official: ${official.join(', ')} (+3 more, full list: get_available_subtitles); auto: en-orig, en.`;
    expect(parseToolError(failed(text))?.tracks).toEqual([
      { type: 'official', langs: official, more: 3 },
      { type: 'auto', langs: ['en-orig', 'en'], more: 0 },
    ]);
  });

  it('reads nothing from a call that did not fail', () => {
    const transcript = { content: [{ type: 'text' as const, text: 'Hello.' }] };
    expect(parseToolError(transcript)).toBeNull();
  });
});
