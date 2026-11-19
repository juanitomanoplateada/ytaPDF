import { applyToPoint, type Matrix } from "./geometry";
import type { Point } from "./polygon";
import { findInString } from "./textSearch";

/**
 * Text recognised on scanned pages (OCR), kept with the geometry of each
 * word so it can be searched, selected and copied in the editor, covered by
 * redaction boxes, and exported as an invisible text layer.
 *
 * Quads are in the page's PDF user space, in reading order: bottom-left,
 * bottom-right, top-right, top-left of the text as it reads.
 */

export interface OcrWord {
  text: string;
  quad: Point[];
}

export interface OcrLine {
  words: OcrWord[];
  quad: Point[];
}

export interface OcrPage {
  lines: OcrLine[];
  /** Tesseract languages used, such as "spa+eng". */
  languages: string;
}

/** OCR results belong to a page of a source document, wherever it is now. */
export const ocrKey = (sourceId: string, sourceIndex: number) => `${sourceId}:${sourceIndex}`;

export const ocrLineText = (line: OcrLine) => line.words.map((word) => word.text).join(" ");

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const length = (a: Point) => Math.hypot(a[0], a[1]);

/** Unit vector along a quad's text direction. */
export function quadDirection(quad: Point[]): Point {
  const along = sub(quad[1], quad[0]);
  const size = length(along) || 1;
  return [along[0] / size, along[1] / size];
}

/** The part of a line from `from` to `to` (distances along it from its start). */
function lineSlice(line: OcrLine, from: number, to: number): Point[] {
  const u = quadDirection(line.quad);
  const at = (p: Point, d: number): Point => [p[0] + u[0] * d, p[1] + u[1] * d];
  return [at(line.quad[0], from), at(line.quad[0], to), at(line.quad[3], to), at(line.quad[3], from)];
}

/** Quads (user space) over every match of `query` in a page's recognised text. */
export function ocrMatchQuads(page: OcrPage | undefined, query: string): Point[][] {
  if (!page) return [];
  const quads: Point[][] = [];
  for (const line of page.lines) {
    if (line.words.length === 0) continue;
    const u = quadDirection(line.quad);
    // Which word each character of the line's text belongs to.
    const wordAt: number[] = [];
    line.words.forEach((word, i) => {
      wordAt.push(...Array.from({ length: word.text.length }, () => i));
      if (i < line.words.length - 1) wordAt.push(i);
    });
    for (const { start, end } of findInString(ocrLineText(line), query)) {
      const first = line.words[wordAt[start]];
      const last = line.words[wordAt[end - 1]];
      const from = dot(sub(first.quad[0], line.quad[0]), u);
      const to = dot(sub(last.quad[1], line.quad[0]), u);
      if (to > from) quads.push(lineSlice(line, from, to));
    }
  }
  return quads;
}

/** A text item in the shape PDF.js's getTextContent gives, for the text layer and the search. */
export interface OcrTextItem {
  str: string;
  dir: "ltr";
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL: boolean;
}

export const OCR_FONT = "ytaOCR";
export const OCR_STYLE = { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false };

/**
 * The recognised text as PDF.js text items: one per word (with a separating
 * space), so selection follows the words where they are on the page.
 */
export function ocrTextItems(page: OcrPage): OcrTextItem[] {
  const items: OcrTextItem[] = [];
  for (const line of page.lines) {
    line.words.forEach((word, i) => {
      const u = quadDirection(word.quad);
      const height = length(sub(word.quad[3], word.quad[0]));
      const width = length(sub(word.quad[1], word.quad[0]));
      if (height <= 0 || width <= 0) return;
      const last = i === line.words.length - 1;
      // The baseline sits a little above the bottom of the box (descenders).
      const v: Point = [-u[1], u[0]];
      const size = height / (OCR_STYLE.ascent - OCR_STYLE.descent);
      const origin: Point = [word.quad[0][0] - v[0] * OCR_STYLE.descent * size, word.quad[0][1] - v[1] * OCR_STYLE.descent * size];
      items.push({
        str: last ? word.text : `${word.text} `,
        dir: "ltr",
        width: last ? width : width + size * 0.25,
        height: size,
        transform: [u[0] * size, u[1] * size, v[0] * size, v[1] * size, origin[0], origin[1]],
        fontName: OCR_FONT,
        hasEOL: last,
      });
    });
  }
  return items;
}

/** Maps a quad from user space to the editor's scene. */
export function toSceneQuad(quad: Point[], viewport: Matrix): Point[] {
  return quad.map(([x, y]) => applyToPoint(viewport, x, y));
}

/** A page's text content with its recognised text added after the document's own. */
export function withOcrText<T extends { items: unknown[]; styles: Record<string, unknown> }>(content: T, page: OcrPage | undefined): T {
  if (!page || page.lines.length === 0) return content;
  return {
    ...content,
    items: [...content.items, ...ocrTextItems(page)],
    styles: { ...content.styles, [OCR_FONT]: OCR_STYLE },
  };
}

/** A short stamp that changes when a page's recognised text does (for caches). */
export const ocrStamp = (page: OcrPage | undefined) =>
  page ? `${page.languages}:${page.lines.length}:${page.lines.reduce((n, line) => n + line.words.length, 0)}` : "";
