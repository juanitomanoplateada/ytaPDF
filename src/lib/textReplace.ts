import { Rect, util, type FabricObject } from "fabric";
import type { PageAnnotations } from "./editor.svelte";
import { applyToPoint, type Matrix } from "./geometry";
import { createNativeText, isNative, isNativeData, type NativeText } from "./nativeText";
import { parseEraseRanges } from "./pdfText/ranges";
import type { AnalyzedChar, PageTextAnalysis, Point, TextUnit } from "./pdfText/types";
import { ocrMatchQuads, toSceneQuad, type OcrPage } from "./ocrText";
import { findInString } from "./textSearch";

/**
 * Find and replace, and redaction by search, on the document's own text.
 * Replacing uses the text editing engine: each line with a match becomes an
 * editable text object (as if the user had clicked it with the Edit text
 * tool) whose text is then changed, so the export rewrites the original
 * glyphs with the same font wherever it can draw the new characters.
 */

interface TextInternals {
  _text: string[];
  insertChars(text: string, style: Record<string, unknown>[] | undefined, start: number, end?: number): void;
  getSelectionStyles(start: number, end: number, complete?: boolean): Record<string, unknown>[];
}

/** Grapheme index (Fabric's text positions) for a UTF-16 index of the text. */
function graphemeIndices(graphemes: string[]) {
  const starts: number[] = [];
  let position = 0;
  for (const grapheme of graphemes) {
    starts.push(position);
    position += grapheme.length;
  }
  return {
    /** The grapheme that contains `unit`. */
    containing(unit: number): number {
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= unit) i++;
      return i;
    },
    /** The first grapheme that starts at or after `unit`. */
    from(unit: number): number {
      let i = 0;
      while (i < starts.length && starts[i] < unit) i++;
      return i;
    },
  };
}

/** Replaces every match inside an editable text object, keeping the style of each match. */
export function replaceInObject(object: NativeText, query: string, replacement: string): number {
  const matches = findInString(object.text, query);
  if (matches.length === 0) return 0;
  const text = object as unknown as TextInternals;
  const split = util.string.graphemeSplit(replacement);
  for (const match of [...matches].reverse()) {
    const index = graphemeIndices(text._text);
    const start = index.containing(match.start);
    const end = Math.max(start + 1, index.from(match.end));
    const style = text.getSelectionStyles(start, start + 1, false)[0] ?? {};
    text.insertChars(
      replacement,
      split.map(() => ({ ...style })),
      start,
      end,
    );
  }
  object.set("dirty", true);
  return matches.length;
}

/**
 * The object as stored in a page's annotations. The editor's own properties
 * are named here too, so this does not depend on the canvas setup being loaded.
 */
const serialize = (object: FabricObject) =>
  (object.toObject as (props: string[]) => Record<string, unknown>).call(object, ["ytaKind", "ytaNative", "ytaLink", "locked"]);

const lineText = (chars: AnalyzedChar[]) => chars.map((c) => c.text).join("");

function glyphKeys(erase: string[]): string[] {
  const keys: string[] = [];
  for (const [op, indices] of parseEraseRanges(erase)) for (const index of indices) keys.push(`${op}:${index}`);
  return keys;
}

export interface ReplaceResult {
  /** The page's annotations after replacing, or null when nothing changed. */
  data: PageAnnotations | null;
  replaced: number;
  /** Matches in text that cannot be edited (fonts that do not say what they draw). */
  skipped: number;
}

/**
 * Replaces `query` with `replacement` on one page: in the text already
 * edited on it and in the lines of the document's text that contain it.
 * `viewport` is the PDF.js viewport transform at scale 1.
 */
export async function replaceOnPage(
  analysis: PageTextAnalysis,
  viewport: Matrix,
  data: PageAnnotations | undefined,
  query: string,
  replacement: string,
): Promise<ReplaceResult> {
  const objects = [...(data?.objects ?? [])];
  let replaced = 0;
  let skipped = 0;
  const taken = new Set<string>();

  // Text the user already edited: change it where it is.
  for (let i = 0; i < objects.length; i++) {
    if (!isNativeData(objects[i])) continue;
    const [object] = await util.enlivenObjects<FabricObject>([objects[i]]);
    if (!isNative(object)) continue;
    for (const key of glyphKeys(object.ytaNative.erase)) taken.add(key);
    const count = replaceInObject(object, query, replacement);
    if (count > 0) {
      objects[i] = serialize(object);
      replaced += count;
    }
  }

  // Lines of the document's text.
  for (const unit of analysis.lines) {
    const matches = findInString(lineText(unit.lines[0] ?? []), query);
    if (matches.length === 0) continue;
    if (glyphKeys(unit.erase).some((key) => taken.has(key))) continue;
    if (!unit.editable) {
      skipped += matches.length;
      continue;
    }
    const object = createNativeText(unit, analysis, viewport);
    const count = replaceInObject(object, query, replacement);
    if (count === 0) continue;
    objects.push(serialize(object));
    for (const key of glyphKeys(unit.erase)) taken.add(key);
    replaced += count;
  }

  return {
    data: replaced > 0 ? { ...data, objects } : null,
    replaced,
    skipped,
  };
}

/** Margin (points) added around each match so its glyphs are fully covered. */
const REDACT_MARGIN = 1;

/** A redaction box covering a quadrilateral given in scene space (bottom-left, bottom-right, top-right, top-left). */
export function redactionBox(corners: Point[], margin = REDACT_MARGIN): Record<string, unknown> {
  const [p0, p1, p2, p3] = corners;
  const along: Point = [p1[0] - p0[0], p1[1] - p0[1]];
  const across: Point = [p3[0] - p0[0], p3[1] - p0[1]];
  const box = new Rect({
    left: (p0[0] + p2[0]) / 2,
    top: (p0[1] + p2[1]) / 2,
    width: Math.hypot(...along) + 2 * margin,
    height: Math.hypot(...across) + 2 * margin,
    angle: (Math.atan2(along[1], along[0]) * 180) / Math.PI,
    fill: "#000000",
    strokeWidth: 0,
  });
  box.set({ ytaKind: "redact" } as Partial<Rect>);
  return serialize(box);
}

/** Scene corners of characters `first`…`last` of a line of a unit, or null without geometry. */
function charsQuad(unit: TextUnit, line: number, first: number, last: number, viewport: Matrix): Point[] | null {
  const chars = unit.lines[line];
  const quad = unit.quads[line];
  if (!chars || !quad) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let i = first; i <= last; i++) {
    const c = chars[i];
    if (c?.x0 === undefined || c.x1 === undefined) continue;
    x0 = Math.min(x0, c.x0);
    x1 = Math.max(x1, c.x1);
  }
  if (!(x1 > x0)) return null;
  const [u0, u1] = unit.u;
  const at = (p: Point, x: number): Point => applyToPoint(viewport, p[0] + u0 * x, p[1] + u1 * x);
  return [at(quad[0], x0), at(quad[0], x1), at(quad[3], x1), at(quad[3], x0)];
}

/** Redaction boxes over every match of `query` in a page's text (scene space). */
export function redactionBoxesFor(analysis: PageTextAnalysis, viewport: Matrix, query: string): Record<string, unknown>[] {
  const boxes: Record<string, unknown>[] = [];
  for (const unit of analysis.lines) {
    const chars = unit.lines[0] ?? [];
    const charAt: number[] = [];
    chars.forEach((c, i) => {
      for (let k = 0; k < c.text.length; k++) charAt.push(i);
    });
    for (const { start, end } of findInString(lineText(chars), query)) {
      const corners = charsQuad(unit, 0, charAt[start], charAt[end - 1], viewport);
      if (corners) boxes.push(redactionBox(corners));
    }
  }
  return boxes;
}

/** Redaction boxes over every match of `query` in the text recognised on a page (OCR). */
export function ocrRedactionBoxes(page: OcrPage | undefined, viewport: Matrix, query: string): Record<string, unknown>[] {
  return ocrMatchQuads(page, query).map((quad) => redactionBox(toSceneQuad(quad, viewport)));
}
