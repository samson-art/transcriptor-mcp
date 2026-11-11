/** A run of plain text, or an address the widget shows as a link. */
export type TextPart = { text: string; href?: string };

// https only: the text comes from a server or a gateway, and a link must not be able to
// start a script or open a local file.
const ADDRESS = /https:\/\/[^\s<>"']+/g;
// The punctuation of the sentence around an address is not part of it.
const SENTENCE_END = /[.,;:!?)\]]+$/;

/** Splits a text into plain runs and https addresses, in order (#106). */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const href = match[0].replace(SENTENCE_END, '');
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: href, href });
    at = match.index + href.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

const UTC_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g;

/**
 * Shows each UTC timestamp of a text ("2026-11-17T00:00:00.000Z") as a date and a time in
 * the language and the zone of the reader (#106). `locale` and `timeZone` are for tests:
 * the widget passes neither, so the browser decides.
 */
export function humanTimes(text: string, locale?: string, timeZone?: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  return text.replace(UTC_TIMESTAMP, (stamp) => {
    const time = new Date(stamp);
    return Number.isNaN(time.getTime()) ? stamp : format.format(time);
  });
}
