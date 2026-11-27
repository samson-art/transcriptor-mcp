/**
 * Shared config for k6 load tests.
 * Usage: import from other scripts or use as k6 shared module.
 */

// k6 sets __ENV; verify-pool.js imports this file in Node, where __ENV does not exist.
// The scripts append paths that start with "/", so a trailing slash would give "//health".
export const BASE_URL = (
  (typeof __ENV !== 'undefined' && __ENV.BASE_URL) ||
  'http://127.0.0.1:3000'
).replace(/\/+$/, '');

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

/**
 * Two-hour podcast pool for load scenario "100 users, 2h podcasts".
 * Real YouTube IDs: JRE, Lex Fridman, Tim Ferriss, Rich Roll, вДудь and other long-form (≥2h).
 * duration in seconds; lang for subtitle/Whisper.
 */
export const PODCAST_2H_POOL = [
  // Joe Rogan Experience (EN)
  { id: '4T_0Tcts6aM', duration: 8261, lang: 'en' },
  { id: 'hBMoPUAeLnY', duration: 10730, lang: 'en' },
  { id: 'GqsA7DYn5BA', duration: 8460, lang: 'en' },
  { id: 'sRj5pxG2JPk', duration: 8280, lang: 'en' },
  { id: 'AbDT2JTSnA8', duration: 8280, lang: 'en' },
  { id: 'QBEZhjnZTks', duration: 11488, lang: 'en' },
  { id: 'qiP1E6iAVS8', duration: 10964, lang: 'en' },
  { id: '1rYtrS5IbrQ', duration: 8459, lang: 'en' },
  { id: 'O4wBUysNe2k', duration: 11906, lang: 'en' },
  { id: '3hptKYix4X8', duration: 8906, lang: 'en' },
  { id: 'yg8aTu1cyCw', duration: 11762, lang: 'en' },
  { id: '1zb2SuW-jug', duration: 11127, lang: 'en' },
  { id: 'TZqADzuu73g', duration: 9000, lang: 'en' },
  { id: 'AVEZBy1uAk8', duration: 9000, lang: 'en' },
  { id: 'XLi_Vr8hm9s', duration: 9000, lang: 'en' },
  { id: 'b2TjpguCYzU', duration: 9000, lang: 'en' },
  { id: 'QBn54YNnKD0', duration: 9000, lang: 'en' },
  { id: 'gcgC532OPhw', duration: 9000, lang: 'en' },
  { id: 'qSLs1-KwasM', duration: 9000, lang: 'en' },
  { id: 'r63cwSWbFME', duration: 9000, lang: 'en' },
  { id: 'mYvGKBCM3Ps', duration: 9000, lang: 'en' },
  { id: 'DfTU5LA_kw8', duration: 9000, lang: 'en' },
  { id: 'livgMzeO-ZY', duration: 9000, lang: 'en' },
  { id: 'ZGJm4bjRaaE', duration: 9000, lang: 'en' },
  { id: '6djZKYdz5ig', duration: 9000, lang: 'en' },
  { id: '5P4Mu4X_zk4', duration: 9000, lang: 'en' },
  { id: 'lwgJhmsQz0U', duration: 9000, lang: 'en' },
  { id: 'qxj8M4ewjS0', duration: 9000, lang: 'en' },
  { id: 'EaAun27gftk', duration: 9000, lang: 'en' },
  { id: 'IbhDeUcZ_iw', duration: 9000, lang: 'en' },
  { id: 'gYcuTY7tnvk', duration: 9000, lang: 'en' },
  { id: 'mpVrOM66khc', duration: 9000, lang: 'en' },
  { id: '0loSsJ1mHVE', duration: 9000, lang: 'en' },
  { id: '0sdLHGb5Wzs', duration: 9000, lang: 'en' },
  { id: 'yTLPVl0y1v4', duration: 9000, lang: 'en' },
  { id: 'J3Wqw8Az7TA', duration: 9000, lang: 'en' },
  { id: 'ko5htRmVIrU', duration: 9000, lang: 'en' },
  { id: 'slYfiSb5AX4', duration: 9000, lang: 'en' },
  { id: 'F8qxwts_bE4', duration: 9000, lang: 'en' },
  { id: 'B7y3qcgSRY8', duration: 9000, lang: 'en' },
  { id: 'By17xYkP6jg', duration: 9000, lang: 'en' },
  { id: 'QOrOYUxzX3o', duration: 9000, lang: 'en' },
  { id: 'spq8UKib3Zw', duration: 9000, lang: 'en' },
  { id: 'G0lTyhvOeJs', duration: 9000, lang: 'en' },
  { id: 'qFwiXyZHYbU', duration: 9000, lang: 'en' },
  { id: 'y2SD_z61FRo', duration: 9000, lang: 'en' },
  { id: 'CH5JoJ_-hic', duration: 9000, lang: 'en' },
  { id: 'OOUc_0-oKRE', duration: 9000, lang: 'en' },
  { id: '0sMrvv53e9Y', duration: 9000, lang: 'en' },
  // Lex Fridman Podcast (EN)
  { id: 'I94u4_Wb82E', duration: 12060, lang: 'en' },
  { id: '4AWLcxTGZPA', duration: 9000, lang: 'en' },
  { id: 'JN3KPFbWCy8', duration: 9000, lang: 'en' },
  { id: 'sY8aFSY2zv4', duration: 9000, lang: 'en' },
  { id: 'qjPH9njnaVU', duration: 9000, lang: 'en' },
  { id: 'DyoVVSggPjY', duration: 9000, lang: 'en' },
  { id: 'NMHiLvirCb0', duration: 9000, lang: 'en' },
  { id: 'f_lRdkH_QoY', duration: 9000, lang: 'en' },
  { id: 'tdv7r2JSokI', duration: 9000, lang: 'en' },
  { id: 'ZPUtA3W-7_I', duration: 9000, lang: 'en' },
  { id: '-k-ztNsBM54', duration: 9000, lang: 'en' },
  { id: 'tOtdJcco3YM', duration: 9000, lang: 'en' },
  { id: 'qa-wl8_wpZA', duration: 9000, lang: 'en' },
  { id: 'uTCc2-1tbBQ', duration: 9000, lang: 'en' },
  { id: 'fUEjCXpOjPY', duration: 9000, lang: 'en' },
  { id: 'zMYvGf7BA9o', duration: 9000, lang: 'en' },
  { id: 'mC43pZkpTec', duration: 9000, lang: 'en' },
  { id: 'pwN8u6HFH8U', duration: 9000, lang: 'en' },
  { id: '-HzgcbRXUK8', duration: 9000, lang: 'en' },
  { id: 'EV7WhVT270Q', duration: 9000, lang: 'en' },
  { id: '_bBRVNkAfkQ', duration: 9000, lang: 'en' },
  // Tim Ferriss / Rich Roll (EN)
  { id: 'YGnnEfmP8K4', duration: 9240, lang: 'en' },
  { id: 'SwQhKFMxmDY', duration: 7961, lang: 'en' },
  { id: 'H9B5mYfBPlY', duration: 9000, lang: 'en' },
  { id: 'xvZB93rnq4Q', duration: 7800, lang: 'en' },
  { id: 'VKHxUJ2BF4c', duration: 9000, lang: 'en' },
  { id: '8LPwyy4scAc', duration: 9000, lang: 'en' },
  { id: 'gWVH8xkdhaY', duration: 9000, lang: 'en' },
  { id: '4AlZGl1o89s', duration: 9000, lang: 'en' },
  { id: 'vrBEbgnG01s', duration: 9000, lang: 'en' },
  { id: '1igJRZlqy70', duration: 9000, lang: 'en' },
  // вДудь / Russian long-form (RU)
  { id: 'EIa4yKctMrk', duration: 10225, lang: 'ru' },
  { id: 'WGixuCIAk1c', duration: 9000, lang: 'ru' },
  { id: 'bBvKKLCL4Zw', duration: 9000, lang: 'ru' },
  { id: 'ytLJssN2cJo', duration: 9000, lang: 'ru' },
  { id: 'hBDMjbzLfWs', duration: 9000, lang: 'ru' },
  { id: 'D6rFxVPz7UI', duration: 9000, lang: 'ru' },
  { id: 'xItdHU7oeVA', duration: 9000, lang: 'ru' },
  { id: '6U9vjtCEXbk', duration: 9000, lang: 'ru' },
  { id: 'NmqVWpSVQrM', duration: 9000, lang: 'ru' },
  { id: 'NJEa-cL_dlk', duration: 9000, lang: 'ru' },
  { id: 'lqRq1KBIe4c', duration: 9000, lang: 'ru' },
  { id: 'Eu1kHIztT24', duration: 9000, lang: 'en' },
  { id: 'lRMReor3hpg', duration: 9000, lang: 'en' },
  { id: 'Hb2rKGfIOrM', duration: 9000, lang: 'en' },
  { id: 'kyUF7T-qhMA', duration: 9000, lang: 'en' },
  { id: '_yyrdsBwWPA', duration: 9000, lang: 'ru' },
  { id: 'I8XOLh-6S_Q', duration: 9000, lang: 'ru' },
  { id: '0SPC_Q7-k40', duration: 9000, lang: 'en' },
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
  const idx = Math.abs((vu * 10000 + Math.trunc(iter)) % VIDEO_POOL.length);
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

/**
 * Returns { url, type, lang } for 2h podcast load scenario. Round-robin over PODCAST_2H_POOL.
 */
export function getPodcast2hRequest(iter, vu) {
  const idx = Math.abs((vu * 10000 + Math.trunc(iter)) % PODCAST_2H_POOL.length);
  const entry = PODCAST_2H_POOL[idx];
  const url = `https://www.youtube.com/watch?v=${entry.id}`;
  return { url, type: 'auto', lang: entry.lang || 'en' };
}
