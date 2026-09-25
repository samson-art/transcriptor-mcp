import { formatDuration, isYouTubePage, pageFromInput, watchUrlAt } from './format';
import { pickDefaultTrack } from './subtitleTracks';
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

  it("shows the video's original language, not the first official track (#54)", () => {
    expect(pickDefaultTrack({ official: ['ar'], auto: ['ar', 'en', 'en-orig'] })).toEqual({
      type: 'auto',
      lang: 'en-orig',
    });
    expect(pickDefaultTrack({ official: ['ar', 'en'], auto: ['en', 'en-orig'] })).toEqual({
      type: 'official',
      lang: 'en',
    });
  });

  it('falls back to English, then the first track, where the server would ask the caller', () => {
    expect(pickDefaultTrack({ official: ['ar', 'en_US'], auto: [] })).toEqual({
      type: 'official',
      lang: 'en_US',
    });
    expect(pickDefaultTrack({ official: ['de', 'fr'], auto: [] })).toEqual({
      type: 'official',
      lang: 'de',
    });
  });

  it('never picks a chat replay as the transcript', () => {
    expect(pickDefaultTrack({ official: ['rechat'], auto: [] })).toBeNull();
    expect(pickDefaultTrack({ official: ['live_chat', 'en'], auto: [] })).toEqual({
      type: 'official',
      lang: 'en',
    });
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
