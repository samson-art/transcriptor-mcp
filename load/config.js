/**
 * Shared config for k6 load tests.
 * Usage: import from other scripts or use as k6 shared module.
 */

export const BASE_URL = 'http://100.65.116.45:3000';

/**
 * Video pool entry: id, duration (seconds), optional subtitle language codes.
 * official / auto: languages verified for this video (e.g. from /subtitles/available).
 * Round-robin selection: index = (__VU * 10000 + __ITER) % VIDEO_POOL.length
 * Use getVideoRequest(iter, vu) to get url + type + lang that match available subtitles.
 */
export const VIDEO_POOL = [
  // Short (≤2 min)
  { id: 'jNQXAC9IVRw', duration: 19, official: [], auto: ['en'] },
  { id: 'Tx1XIm6q4r4', duration: 127, official: [], auto: ['en'] },
  { id: 'dQw4w9WgXcQ', duration: 213, official: ['en'], auto: ['en'] },
  { id: '9bZkp7q19f0', duration: 252, official: ['en', 'ko'], auto: ['en', 'ko'] },
  { id: 'kJQP7kiw5Fk', duration: 282, official: ['en', 'es'], auto: ['en', 'es'] },
  { id: 'gocwRvLhDf8', duration: 310, official: ['en'], auto: ['en'] },
  // Medium (3–6 min)
  { id: 'RgKAFK5djSk', duration: 229, official: ['en'], auto: ['en'] },
  { id: 'CevxZvSJLk8', duration: 236, official: ['en'], auto: ['en'] },
  { id: 'OPf0YbXqDm0', duration: 269, official: ['en'], auto: ['en'] },
  { id: 'YQHsXMglC9A', duration: 295, official: ['en'], auto: ['en'] },
  { id: '09R8_2nJtjg', duration: 235, official: ['en'], auto: ['en'] },
  { id: 'fJ9rUzIMcZQ', duration: 355, official: ['en'], auto: ['en'] },
  { id: 'hT_nvWreIhg', duration: 261, official: ['en'], auto: ['en'] },
  { id: 'JGwWNGJdvx8', duration: 211, official: ['en'], auto: ['en'] },
  { id: '2Vv-BfVoq4g', duration: 279, official: ['en'], auto: ['en'] },
  { id: '1G4isv_Fylg', duration: 276, official: [], auto: ['en'] },
  { id: 'Ks-_Mh1QhMc', duration: 1283, official: ['en'], auto: ['en'] },
  { id: 'LjhCEhWiKXk', duration: 218, official: ['en'], auto: ['en'] },
  { id: 'hLQl3WQQoQ0', duration: 285, official: ['en'], auto: ['en'] },
  { id: '7wtfhZwyrcc', duration: 231, official: ['en'], auto: ['en'] },
  { id: 'lp-EO5I60KA', duration: 281, official: [], auto: ['en'] },
  { id: 'ZbZSe6N_BXs', duration: 233, official: ['en'], auto: ['en'] },
  // Long (7–15 min)
  { id: 'arj7oStGLkU', duration: 844, official: ['en'], auto: ['en'] },
  { id: 'Sm5xF-UYgdg', duration: 1149, official: ['en'], auto: ['en'] },
  { id: 'iG9CE55wbtY', duration: 1203, official: ['en'], auto: ['en'] },
  { id: '8jPQjjsBbIc', duration: 618, official: ['en'], auto: ['en'] },
  { id: 'KQ6zr6kCPj8', duration: 636, official: ['en'], auto: ['en'] },
  { id: 'e-ORhEE9VVg', duration: 360, official: ['en'], auto: ['en'] },
  { id: 'pRpeEdMmmQ0', duration: 257, official: ['en'], auto: ['en'] },
  { id: 'SlPhMPnQ58k', duration: 319, official: [], auto: ['en'] },
];

export const VIDEO_IDS = VIDEO_POOL.map((v) => v.id);

const DEFAULT_TYPE = 'auto';
const DEFAULT_LANG = 'en';

/**
 * Picks type and lang for a pool entry. Prefers lang in auto, then official; else first available; else defaults.
 */
function pickTypeAndLang(entry) {
  const auto = entry.auto || [];
  const official = entry.official || [];
  if (auto.includes(DEFAULT_LANG))
    return { type: 'auto', lang: DEFAULT_LANG };
  if (official.includes(DEFAULT_LANG))
    return { type: 'official', lang: DEFAULT_LANG };
  if (auto.length > 0) return { type: 'auto', lang: auto[0] };
  if (official.length > 0) return { type: 'official', lang: official[0] };
  return { type: DEFAULT_TYPE, lang: DEFAULT_LANG };
}

/**
 * Returns { url, type, lang } for load tests. Type and lang match this video's available subtitles when metadata present.
 */
export function getVideoRequest(iter, vu) {
  const idx = Math.abs((vu * 10000 + (iter | 0)) % VIDEO_POOL.length);
  const entry = VIDEO_POOL[idx];
  const url = `https://www.youtube.com/watch?v=${entry.id}`;
  const { type, lang } = pickTypeAndLang(entry);
  return { url, type, lang };
}

/**
 * Returns only the video URL (round-robin). Kept for backward compatibility.
 */
export function getVideoUrl(iter, vu) {
  return getVideoRequest(iter, vu).url;
}
