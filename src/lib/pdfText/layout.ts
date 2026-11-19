import { applyToPoint } from "../geometry";
import type { PdfFont } from "./fonts";
import { baselineMatrix, type Glyph } from "./interpreter";
import type { Point } from "./types";

/**
 * Groups the glyphs of a page into lines and paragraphs by their geometry,
 * independently of the order the content stream draws them in.
 */

export interface PlacedGlyph {
  glyph: Glyph;
  /** Baseline origin (user space, rise excluded). */
  origin: Point;
  /** Extent along the baseline direction. */
  x0: number;
  x1: number;
  /** Position across the baseline (along the left normal of `u`). */
  perp: number;
  /** Em size in user space units. */
  size: number;
  u: Point;
  v: Point;
  /** Width / height scale of the glyph matrix. */
  hScale: number;
  /** Drawn again over an identical glyph (fake bold): erased, not repeated. */
  duplicate: boolean;
}

export interface LayoutChar {
  text: string;
  /** The glyph drawn, or for inferred spaces the glyph before the gap. */
  glyph: PlacedGlyph;
  inferred: boolean;
}

export interface LayoutLine {
  glyphs: PlacedGlyph[];
  chars: LayoutChar[];
  u: Point;
  n: Point;
  perp: number;
  start: number;
  end: number;
  size: number;
}

export interface LayoutParagraph {
  lines: LayoutLine[];
  joins: ("\n" | " " | "")[];
  align: "left" | "center" | "right" | "justify";
  left: number;
  right: number;
  leading: number;
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const sameDirection = (a: Point, b: Point) => dot(a, b) > 0.9985;

function place(glyph: Glyph): PlacedGlyph | undefined {
  const m = baselineMatrix(glyph);
  const lx = Math.hypot(m[0], m[1]);
  const ly = Math.hypot(m[2], m[3]);
  if (lx <= 1e-6 || ly <= 1e-6 || !Number.isFinite(lx + ly + m[4] + m[5])) return undefined;
  const u: Point = [m[0] / lx, m[1] / lx];
  const n: Point = [-u[1], u[0]];
  const origin: Point = [m[4], m[5]];
  const end = applyToPoint(m, glyph.font.width(glyph.code) * glyph.font.scale, 0);
  const x0 = dot(origin, u);
  const x1 = dot(end, u);
  return {
    glyph,
    origin,
    x0,
    x1: Math.max(x0, x1),
    perp: dot(origin, n),
    size: ly,
    u,
    v: [m[2] / ly, m[3] / ly],
    hScale: lx / ly,
    duplicate: false,
  };
}

const spaceWidths = new WeakMap<PdfFont, number>();

/** Width of a word space in ems: the font's own space glyph, or a typical value. */
export function spaceEm(font: PdfFont): number {
  let width = spaceWidths.get(font);
  if (width === undefined) {
    width = ownSpaceWidth(font);
    if (!(width > 0.05 && width < 1)) width = 0.25;
    spaceWidths.set(font, width);
  }
  return width;
}

/** Width (em) of the font's own space glyph: code 32, or any code that draws a space. */
function ownSpaceWidth(font: PdfFont): number {
  if (!font.composite && font.unicode(32) === " ") {
    const width = font.width(32) * font.scale;
    if (width > 0) return width;
  }
  const code = font.mappedCodes().find((c) => font.unicode(c) === " ");
  return code === undefined ? 0 : font.width(code) * font.scale;
}

const isSpace = (text: string | undefined) => text !== undefined && /^\s+$/u.test(text);

/** Glyphs that are part of the readable text of the page. */
function visibleGlyphs(glyphs: Glyph[]): PlacedGlyph[] {
  const placed: PlacedGlyph[] = [];
  for (const glyph of glyphs) {
    if (glyph.vertical || glyph.renderMode > 2) continue;
    const item = place(glyph);
    if (item && item.size > 0.5) placed.push(item);
  }
  return placed;
}

/** Splits glyphs, in drawing order, into runs that continue one another. */
function chunks(glyphs: PlacedGlyph[]): PlacedGlyph[][] {
  const result: PlacedGlyph[][] = [];
  let current: PlacedGlyph[] = [];
  for (const g of glyphs) {
    const last = current.at(-1);
    const size = last ? Math.max(last.size, g.size) : g.size;
    const continues =
      last !== undefined &&
      sameDirection(last.u, g.u) &&
      Math.abs(g.perp - last.perp) < 0.2 * size &&
      g.x0 - last.x1 > -0.6 * size &&
      g.x0 - last.x1 < 1.5 * size;
    if (!continues && current.length > 0) {
      result.push(current);
      current = [];
    }
    current.push(g);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function extent(glyphs: PlacedGlyph[]): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const g of glyphs) {
    start = Math.min(start, g.x0);
    end = Math.max(end, g.x1);
  }
  return { start, end };
}

/** Whether `chunk` repeats glyphs of `line` at (almost) the same place: fake bold. */
function duplicates(line: PlacedGlyph[], chunk: PlacedGlyph[]): boolean {
  return chunk.every((g) =>
    line.some((o) => o.glyph.unicode === g.glyph.unicode && Math.abs(o.x0 - g.x0) < 0.15 * g.size && Math.abs(o.perp - g.perp) < 0.15 * g.size),
  );
}

function dominantSize(glyphs: PlacedGlyph[]): number {
  const counts = new Map<number, number>();
  for (const g of glyphs) {
    const key = Math.round(g.size * 10) / 10;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = glyphs[0]?.size ?? 0;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

interface LineExtent {
  u: Point;
  perp: number;
  size: number;
  start: number;
  end: number;
}

/** Whether a piece of text sits on a line's baseline, close enough along it to be part of it. */
function continuesLine(line: LineExtent, piece: LineExtent): boolean {
  if (!sameDirection(line.u, piece.u)) return false;
  if (Math.abs(line.perp - piece.perp) > 0.25 * Math.min(line.size, piece.size)) return false;
  const gap = Math.max(piece.start - line.end, line.start - piece.end);
  return gap <= 1.5 * Math.max(line.size, piece.size);
}

/** A piece drawn over a line's text (other than the same glyphs drawn again) is another line. */
function overlapsWithoutDuplicating(line: LineExtent, piece: LineExtent, glyphs: PlacedGlyph[], chunk: PlacedGlyph[]): boolean {
  const overlap = Math.min(piece.end, line.end) - Math.max(piece.start, line.start);
  return overlap > 0.3 * piece.size && !duplicates(glyphs, chunk);
}

/** Groups the page's glyphs into lines, each sorted along its baseline. */
export function buildLines(glyphs: Glyph[]): LayoutLine[] {
  const groups: PlacedGlyph[][] = [];
  const info: LineExtent[] = [];

  for (const chunk of chunks(visibleGlyphs(glyphs))) {
    const { start, end } = extent(chunk);
    const size = dominantSize(chunk);
    const u = chunk[0].u;
    const perp = chunk[0].perp;
    const piece = { u, perp, size, start, end };
    const target = info.findIndex((line, i) => continuesLine(line, piece) && !overlapsWithoutDuplicating(line, piece, groups[i], chunk));
    if (target < 0) {
      groups.push([...chunk]);
      info.push({ u, perp, size, start, end });
    } else {
      groups[target].push(...chunk);
      const line = info[target];
      line.start = Math.min(line.start, start);
      line.end = Math.max(line.end, end);
    }
  }

  return groups.map(finishLine).filter((line): line is LayoutLine => line !== null);
}

function finishLine(glyphs: PlacedGlyph[]): LayoutLine | null {
  glyphs.sort((a, b) => a.x0 - b.x0 || a.glyph.op - b.glyph.op || a.glyph.index - b.glyph.index);
  markDuplicates(glyphs);
  const drawn = glyphs.filter((g) => !g.duplicate);
  const visible = drawn.filter((g) => !isSpace(g.glyph.unicode));
  if (visible.length === 0) return null;
  const chars = lineChars(drawn);

  const first = visible[0];
  return {
    glyphs,
    chars,
    u: first.u,
    n: [-first.u[1], first.u[0]],
    perp: dominantPerp(visible),
    start: first.x0,
    end: Math.max(...visible.map((g) => g.x1)),
    size: dominantSize(visible),
  };
}

/** A glyph drawn again on top of the same one only thickens it (fake bold). */
function markDuplicates(glyphs: PlacedGlyph[]): void {
  const kept: PlacedGlyph[] = [];
  for (const g of glyphs) {
    const twin = kept.find(
      (o) => !o.duplicate && o.glyph.unicode === g.glyph.unicode && Math.abs(o.x0 - g.x0) < 0.15 * g.size && o.glyph !== g.glyph,
    );
    if (twin && Math.abs(twin.perp - g.perp) < 0.15 * g.size) g.duplicate = true;
    kept.push(g);
  }
}

/** Whether the gap between two glyphs is wide enough to be a space nobody drew. */
function gapIsSpace(previous: PlacedGlyph, g: PlacedGlyph): boolean {
  if (isSpace(previous.glyph.unicode) || isSpace(g.glyph.unicode)) return false;
  const space = spaceEm(previous.glyph.font) * previous.size;
  const threshold = Math.min(Math.max(0.6 * space, 0.1 * g.size), 0.3 * g.size);
  return g.x0 - previous.x1 > threshold;
}

/** The characters of a line: its glyphs' text, with inferred spaces and no repeated or trailing ones. */
function lineChars(drawn: PlacedGlyph[]): LayoutChar[] {
  const chars: LayoutChar[] = [];
  let previous: PlacedGlyph | undefined;
  for (const g of drawn) {
    const text = g.glyph.unicode;
    if (text !== undefined && /^[\u0000-\u001f]+$/.test(text)) continue;
    if (previous && gapIsSpace(previous, g)) chars.push({ text: " ", glyph: previous, inferred: true });
    previous = g;
    const space = isSpace(text);
    if (space && (chars.length === 0 || chars.at(-1)?.text === " ")) continue;
    chars.push({ text: space ? " " : (text ?? "\uFFFD"), glyph: g, inferred: false });
  }
  while (chars.at(-1)?.text === " ") chars.pop();
  return chars;
}

/** Baseline position shared by most glyphs (superscripts excluded). */
function dominantPerp(glyphs: PlacedGlyph[]): number {
  const sorted = glyphs.map((g) => g.perp).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Width of the first word of a line, for deciding whether it would have fitted above. */
function firstWordWidth(line: LayoutLine): number {
  let end = line.start;
  for (const c of line.chars) {
    if (c.text === " ") break;
    end = c.glyph.x1;
  }
  return end - line.start;
}

/**
 * Groups lines into paragraphs: consecutive lines of the same size and
 * direction, with a regular line spacing and a common alignment. Lines that
 * cannot be read reliably stay on their own.
 */
export function buildParagraphs(lines: LayoutLine[], canJoin: (line: LayoutLine) => boolean): LayoutParagraph[] {
  const paragraphs: LayoutParagraph[] = [];
  for (const block of lineBlocks(lines, canJoin)) {
    const align = block.lines.length > 1 ? alignmentOf(block.lines) : "left";
    if (align === null) paragraphs.push(...block.lines.map(single));
    else paragraphs.push(finishParagraph(block.lines, align));
  }
  return paragraphs;
}

/** Lines in reading order: by direction, then top to bottom and left to right. */
function readingOrder(a: LayoutLine, b: LayoutLine): number {
  if (!sameDirection(a.u, b.u)) return Math.atan2(a.u[1], a.u[0]) - Math.atan2(b.u[1], b.u[0]);
  return b.perp - a.perp || a.start - b.start;
}

/** Each line joins the block whose last line is closest above it and that it can continue. */
function lineBlocks(lines: LayoutLine[], canJoin: (line: LayoutLine) => boolean): LineBlock[] {
  const blocks: LineBlock[] = [];
  for (const line of [...lines].sort(readingOrder)) {
    let best: LineBlock | undefined;
    let bestDistance = Infinity;
    for (const block of canJoin(line) ? blocks : []) {
      const distance = joinDistance(block, line, canJoin);
      if (distance === null || distance >= bestDistance) continue;
      best = block;
      bestDistance = distance;
    }
    if (!best) {
      blocks.push({ lines: [line], leading: 0 });
      continue;
    }
    if (best.lines.length === 1) best.leading = bestDistance;
    best.lines.push(line);
  }
  return blocks;
}

interface LineBlock {
  lines: LayoutLine[];
  leading: number;
}

/**
 * How far `line` is below the last line of a block it can continue (same
 * size and direction, regular spacing, overlapping and aligned), or null.
 */
function joinDistance(block: LineBlock, line: LayoutLine, canJoin: (line: LayoutLine) => boolean): number | null {
  const last = block.lines.at(-1);
  if (!last || !canJoin(last) || !sameDirection(last.u, line.u)) return null;
  const size = Math.max(last.size, line.size);
  if (Math.abs(last.size - line.size) > 0.15 * size) return null;
  const distance = last.perp - line.perp;
  if (distance < 0.8 * size || distance > 2.2 * size) return null;
  if (block.leading > 0 && Math.abs(distance - block.leading) > 0.2 * size) return null;
  const overlap = Math.min(last.end, line.end) - Math.max(last.start, line.start);
  return overlap > 0 && alignedWith(block, last, line, size) ? distance : null;
}

/** Whether a line lines up with a block: same left or right edge, same centre, or a first-line indent. */
function alignedWith(block: LineBlock, last: LayoutLine, line: LayoutLine, size: number): boolean {
  const left = Math.min(...block.lines.map((l) => l.start));
  const right = Math.max(...block.lines.map((l) => l.end));
  return (
    Math.abs(line.start - left) < 0.75 * size ||
    Math.abs(line.end - right) < 0.75 * size ||
    Math.abs((line.start + line.end) / 2 - (last.start + last.end) / 2) < 0.75 * size ||
    (block.lines.length === 1 && line.start < last.start && last.start - line.start < 5 * size)
  );
}

function single(line: LayoutLine): LayoutParagraph {
  return { lines: [line], joins: [], align: "left", left: line.start, right: line.end, leading: 0 };
}

function alignmentOf(lines: LayoutLine[]): LayoutParagraph["align"] | null {
  const size = Math.max(...lines.map((l) => l.size));
  const tolerance = 0.5 * size;
  const left = Math.min(...lines.map((l) => l.start));
  const right = Math.max(...lines.map((l) => l.end));
  const body = lines.slice(1);
  const lefts = body.every((l) => Math.abs(l.start - left) < tolerance) && lines[0].start - left < 5 * size;
  const rights = lines.slice(0, -1).every((l) => Math.abs(l.end - right) < tolerance || endsParagraph(l, right, size));
  const centers = lines.every((l) => Math.abs((l.start + l.end) / 2 - (left + right) / 2) < tolerance);
  const allRight = lines.every((l) => Math.abs(l.end - right) < tolerance);
  const fullLines = lines.slice(0, -1).filter((l) => Math.abs(l.end - right) < tolerance).length;

  if (lefts && rights && fullLines >= 1 && looksJustified(lines, right, size)) return "justify";
  if (lefts) return "left";
  if (allRight) return "right";
  if (centers) return "center";
  return null;
}

/** Short lines inside justified text end a paragraph. */
function endsParagraph(line: LayoutLine, right: number, size: number): boolean {
  return right - line.end > 1.5 * size;
}

/**
 * Justified text stretches its spaces so every line that does not end a
 * paragraph reaches the right edge. In ragged text only the longest line
 * does, and it is not stretched.
 */
function looksJustified(lines: LayoutLine[], right: number, size: number): boolean {
  const inner = lines.slice(0, -1).filter((l) => !endsParagraph(l, right, size));
  if (inner.length === 0 || !inner.every((l) => Math.abs(l.end - right) < 0.5 * size)) return false;
  return inner.some((l) => l.end - l.start - naturalWidth(l) > 0.25 * l.size);
}

/** Width of a line with plain spaces and no kerning, in user space. */
export function naturalWidth(line: LayoutLine): number {
  let width = 0;
  for (const c of line.chars) {
    const g = c.glyph;
    const em = c.inferred ? spaceEm(g.glyph.font) : g.glyph.font.width(g.glyph.code) * g.glyph.font.scale;
    width += em * g.size * g.hScale;
  }
  return width;
}

function finishParagraph(lines: LayoutLine[], align: LayoutParagraph["align"]): LayoutParagraph {
  const size = Math.max(...lines.map((l) => l.size));
  const left = Math.min(...lines.map((l) => l.start));
  const right = Math.max(...lines.map((l) => l.end));
  const distances = lines.slice(1).map((l, i) => lines[i].perp - l.perp).sort((a, b) => a - b);
  const leading = distances[Math.floor(distances.length / 2)] ?? 0;

  const joins: LayoutParagraph["joins"] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const lastText = line.chars.at(-1)?.text ?? "";
    const nextFirst = next.chars[0]?.text ?? "";
    const hyphenated = /[-\u00ad\u2010]$/.test(lastText) && /^\p{L}/u.test(nextFirst);
    const indented = (align === "left" || align === "justify") && next.start - left > size;
    const short =
      align === "justify"
        ? endsParagraph(line, right, size)
        : align === "left" && firstWordWidth(next) + 0.3 * size < right - line.end;
    joins.push(hyphenated || indented || short ? "\n" : " ");
  }
  return { lines, joins, align, left, right, leading };
}
