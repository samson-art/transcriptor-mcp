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
