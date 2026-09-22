/** Platform identity of a video URL, shared by callers that must not import each other. */

/** Extracts platform identifier from input URL hostname (youtube, reddit, vimeo, etc.). */
export function extractPlatformFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('reddit') || hostname.includes('v.redd.it')) return 'reddit';
    if (hostname.includes('vimeo')) return 'vimeo';
    if (hostname.includes('tiktok')) return 'tiktok';
    if (hostname.includes('twitch')) return 'twitch';
    if (hostname.includes('twitter') || hostname === 'x.com' || hostname.endsWith('.x.com'))
      return 'twitter';
    if (hostname.includes('instagram')) return 'instagram';
    if (hostname.includes('facebook') || hostname.includes('fb.')) return 'facebook';
    if (hostname.includes('bilibili')) return 'bilibili';
    if (
      hostname === 'vk.com' ||
      hostname.endsWith('.vk.com') ||
      hostname === 'vk.ru' ||
      hostname.endsWith('.vk.ru') ||
      hostname === 'vkvideo.ru' ||
      hostname.endsWith('.vkvideo.ru')
    )
      return 'vk';
    if (hostname.includes('dailymotion')) return 'dailymotion';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
