/**
 * Text search over the text PDF.js extracts from each page. Matching ignores
 * case and accents ("canción" finds "CANCION"), and every match keeps the
 * position of its first and last character in the page's text items, which
 * is what the text layer needs to highlight it.
 */

/** One text item of a page, as PDF.js's getTextContent lists them (only those with text). */
export interface SearchItem {
  str: string;
  hasEOL?: boolean;
}

export interface PageText {
  /** The page's text: items joined, with a space where a line ends. */
  text: string;
  /** For each character of `text`, its item and offset; separators belong to the previous item. */
  positions: { item: number; offset: number }[];
  /** `text` normalised for searching. */
  normalized: string;
  /** For each character of `normalized`, the index of the character of `text` it came from. */
  sources: number[];
}

/** A match from `start` to `end` (inclusive), as item and offset. */
export interface TextRange {
  start: { item: number; offset: number };
  end: { item: number; offset: number };
}

/** Lower case, without accents or other combining marks; any space becomes a plain space. */
export function normalizeChar(char: string): string {
  if (/\s/u.test(char)) return " ";
  return char.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase();
}

export function normalizeQuery(query: string): string {
  return Array.from(query.trim(), normalizeChar).join("").replaceAll(/ +/g, " ");
}

export function buildPageText(items: SearchItem[]): PageText {
  let text = "";
  const positions: PageText["positions"] = [];
  items.forEach((item, index) => {
    for (let offset = 0; offset < item.str.length; offset++) {
      positions.push({ item: index, offset });
    }
    text += item.str;
    if (item.hasEOL) {
      positions.push({ item: index, offset: Math.max(0, item.str.length - 1) });
      text += " ";
    }
  });

  let normalized = "";
  const sources: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeChar(text[i]);
    // Collapse runs of spaces, so "a  b" in the PDF matches "a b".
    if (piece === " " && normalized.endsWith(" ")) continue;
    for (const char of piece) {
      normalized += char;
      sources.push(i);
    }
  }
  return { text, positions, normalized, sources };
}

/** Every match of `query` in a page, in reading order. */
export function findInPage(page: PageText, query: string): TextRange[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const ranges: TextRange[] = [];
  let from = 0;
  for (;;) {
    const at = page.normalized.indexOf(needle, from);
    if (at < 0) break;
    const first = page.sources[at];
    const last = page.sources[at + needle.length - 1];
    ranges.push({ start: page.positions[first], end: page.positions[last] });
    from = at + needle.length;
  }
  return ranges;
}

/** Matches of `query` in a plain string, as [start, end) UTF-16 indices, matched like the search. */
export function findInString(text: string, query: string): { start: number; end: number }[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  let normalized = "";
  const sources: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeChar(text[i]);
    if (piece === " " && normalized.endsWith(" ")) continue;
    for (const char of piece) {
      normalized += char;
      sources.push(i);
    }
  }
  const matches: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = normalized.indexOf(needle, from);
    if (at < 0) break;
    matches.push({ start: sources[at], end: sources[at + needle.length - 1] + 1 });
    from = at + needle.length;
  }
  return matches;
}
