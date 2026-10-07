import { classRegistry, IText, Textbox, util, type FabricObject } from "fabric";
import { applyToPoint, objectToPdf, sceneToPdf, type Matrix } from "./geometry";
import { isBoldWeight, isItalicStyle } from "./fonts";
import { colorToHex, hexToColor, type FillColor } from "./pdfText/color";
import type { AnalyzedChar, AnalyzedFont, NativeRun, NativeSpec, NativeUnderline, PageTextAnalysis, Point, TextUnit } from "./pdfText/types";

/**
 * Text of the document turned into an editable object. It is a Fabric text
 * that measures every character with the widths of the PDF font it came
 * from, so lines wrap and justify exactly as they will in the exported file,
 * and it remembers which original glyphs it replaces.
 */

export interface NativeFont {
  name: string;
  /** Glyph that locates the font object when exporting. */
  sample: string;
  key: string;
  bold: boolean;
  italic: boolean;
  /** CSS stack; its first family is the marker "yta-f<index>". */
  css: string;
  glyphs: Record<string, [number, number, number]>;
}

export interface NativeData {
  unit: string;
  kind: TextUnit["kind"];
  erase: string[];
  insertAfter: string;
  fonts: NativeFont[];
  /** Original colours, by the hex value shown in the editor. */
  colors: [string, FillColor][];
  /** Fill opacity of the original text. */
  alpha: number;
  renderMode: number;
  /** The last line was justified too (the text continued elsewhere). */
  justifyLast: boolean;
  /** Lines the text had in the document. */
  lineCount: number;
  /** The text as it was in the document. */
  original: string;
  /** Outline of the original lines (user space). */
  area: Point[][];
  /** The text was deleted: only the erasure remains. */
  deleted?: boolean;
}

interface GraphemeBox {
  left: number;
  width: number;
  kernedWidth: number;
  deltaY?: number;
}

/** Fabric internals used for layout, stable across Fabric 6 and 7. */
interface TextInternals {
  __charBounds: GraphemeBox[][];
  _textLines: string[][];
  textLines: string[];
  _fontSizeFraction: number;
  _fontSizeMult: number;
  _reSpacesAndTabs: RegExp;
  _reSpaceAndTab: RegExp;
  width: number;
  _getLeftOffset(): number;
  _getTopOffset(): number;
  _getLineLeftOffset(lineIndex: number): number;
  getHeightOfLine(lineIndex: number): number;
  getHeightOfLineImpl(lineIndex: number): number;
  getLineWidth(lineIndex: number): number;
  isEndOfWrapping(lineIndex: number): boolean;
  getCompleteStyleDeclaration(lineIndex: number, charIndex: number): Record<string, unknown>;
  _renderChar(
    method: "fillText" | "strokeText",
    ctx: CanvasRenderingContext2D,
    lineIndex: number,
    charIndex: number,
    char: string,
    left: number,
    top: number,
  ): void;
}

const internals = (object: unknown) => object as TextInternals;

type Measured = { width: number; kernedWidth: number };

const MARKER = /^\s*yta-f(\d+)\s*(,|$)/;

export function originalFontIndex(fontFamily: unknown): number | undefined {
  if (typeof fontFamily !== "string") return undefined;
  const match = MARKER.exec(fontFamily);
  return match ? Number(match[1]) : undefined;
}

/** Name of the original font a CSS stack refers to, for the font menu. */
export function originalFontLabel(fontFamily: string): string | undefined {
  if (originalFontIndex(fontFamily) === undefined) return undefined;
  return /"([^"]+)"/.exec(fontFamily)?.[1];
}

/** The CSS stack without the original-font marker, for text that is no longer native. */
export function plainFontFamily(fontFamily: string): string {
  return fontFamily.replace(MARKER, "").trim() || "Helvetica, Arial, sans-serif";
}

/** The original font a character is drawn with, if its style still matches that font. */
function originalFontFor(data: NativeData | undefined, style: Record<string, unknown>): NativeFont | undefined {
  const index = originalFontIndex(style.fontFamily);
  const font = data && index !== undefined ? data.fonts[index] : undefined;
  if (!font) return undefined;
  // Bold or italic applied to a font that is not: the export uses a standard font instead.
  const sameStyle =
    isBoldWeight(style.fontWeight as string) === font.bold && isItalicStyle(style.fontStyle as string) === font.italic;
  return sameStyle ? font : undefined;
}

function measure(object: { ytaNative?: NativeData }, char: string, style: Record<string, unknown>): Measured | undefined {
  const entry = originalFontFor(object.ytaNative, style)?.glyphs[char];
  if (!entry) return undefined;
  const width = (entry[2] / 1000) * Number(style.fontSize);
  return { width, kernedWidth: width };
}

/** Draws each character at its measured place, so glyphs line up with the caret and the export. */
function renderEachChar(
  object: unknown,
  method: "fillText" | "strokeText",
  ctx: CanvasRenderingContext2D,
  line: string[],
  left: number,
  top: number,
  lineIndex: number,
): void {
  const text = internals(object);
  const bounds = text.__charBounds[lineIndex];
  ctx.save();
  const baselineTop = top - text.getHeightOfLineImpl(lineIndex) * text._fontSizeFraction;
  for (let i = 0; i < line.length; i++) {
    const box = bounds?.[i];
    if (!box) continue;
    text._renderChar(method, ctx, lineIndex, i, line[i], left + box.left, baselineTop);
  }
  ctx.restore();
}

export class NativeLine extends IText {
  static type = "NativeLine";
  declare ytaNative: NativeData;
  /** The page bitmap already shows this text: draw nothing but keep it selectable. */
  ytaGhost = false;

  _measureChar(...args: Parameters<IText["_measureChar"]>): Measured {
    return measure(this, args[0], args[1] as Record<string, unknown>) ?? super._measureChar(...args);
  }

  _renderChars(method: "fillText" | "strokeText", ctx: CanvasRenderingContext2D, line: string[], left: number, top: number, lineIndex: number) {
    renderEachChar(this, method, ctx, line, left, top, lineIndex);
  }

  _render(ctx: CanvasRenderingContext2D) {
    if (!this.ytaGhost) super._render(ctx);
  }
}

export class NativeBlock extends Textbox {
  static type = "NativeBlock";
  declare ytaNative: NativeData;
  ytaGhost = false;

  _measureChar(...args: Parameters<Textbox["_measureChar"]>): Measured {
    return measure(this, args[0], args[1] as Record<string, unknown>) ?? super._measureChar(...args);
  }

  _renderChars(method: "fillText" | "strokeText", ctx: CanvasRenderingContext2D, line: string[], left: number, top: number, lineIndex: number) {
    renderEachChar(this, method, ctx, line, left, top, lineIndex);
  }

  _render(ctx: CanvasRenderingContext2D) {
    if (!this.ytaGhost) super._render(ctx);
  }

  /**
   * Justifies like the original: every wrapped line, lines ending in a hyphen
   * that were kept as forced breaks, and the last line when the text
   * continues elsewhere.
   */
  enlargeSpaces() {
    const text = internals(this);
    const count = text._textLines.length;
    for (let i = 0; i < count; i++) {
      const graphemes = text._textLines[i];
      const last = i === count - 1;
      // The last line stays justified only while the text keeps its original lines.
      const justify = last
        ? this.ytaNative?.justifyLast === true && count <= (this.ytaNative.lineCount ?? count)
        : !text.isEndOfWrapping(i) || /[-\u00ad\u2010]$/.test(graphemes.join(""));
      if (!justify) continue;
      const lineWidth = text.getLineWidth(i);
      const spaces = text.textLines[i].match(text._reSpacesAndTabs);
      if (lineWidth >= text.width || !spaces) continue;
      const extra = (text.width - lineWidth) / spaces.length;
      let shift = 0;
      for (let j = 0; j <= graphemes.length; j++) {
        const box = text.__charBounds[i][j];
        if (!box) continue;
        if (text._reSpaceAndTab.test(graphemes[j])) {
          box.width += extra;
          box.kernedWidth += extra;
          box.left += shift;
          shift += extra;
        } else {
          box.left += shift;
        }
      }
    }
  }
}

classRegistry.setClass(NativeLine);
classRegistry.setClass(NativeBlock);

export type NativeText = NativeLine | NativeBlock;

export function isNative(object: FabricObject | null | undefined): object is NativeText {
  return object instanceof NativeLine || object instanceof NativeBlock;
}

/** Serialised objects (JSON) that are native text. */
export function isNativeData(object: Record<string, unknown>): boolean {
  return object.ytaNative !== undefined && object.ytaNative !== null;
}

// ── Creation ───────────────────────────────────────────────────────────────

function genericStack(font: AnalyzedFont): string {
  if (font.monospace) return '"Courier New", Courier, monospace';
  if (font.serif) return '"Times New Roman", Times, serif';
  return "Helvetica, Arial, sans-serif";
}

function nativeFont(font: AnalyzedFont, index: number): NativeFont {
  const families = font.families.map((family) => `"${family.replace(/"/g, "")}"`);
  return {
    name: font.name,
    sample: font.sample,
    key: font.key,
    bold: font.bold,
    italic: font.italic,
    css: [`yta-f${index}`, ...families, genericStack(font)].join(", "),
    glyphs: font.glyphs,
  };
}

const linear = (m: Matrix): Matrix => [m[0], m[1], m[2], m[3], 0, 0];
const length = (p: Point) => Math.hypot(p[0], p[1]);
const normalize = (p: Point): Point => {
  const l = length(p) || 1;
  return [p[0] / l, p[1] / l];
};
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

function mostCommon<T>(values: T[], key: (value: T) => string): T {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const k = key(value);
    const entry = counts.get(k) ?? { value, count: 0 };
    entry.count++;
    counts.set(k, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0].value;
}

/**
 * Builds the editable object for a line or paragraph of the page, placed
 * exactly over the original text. `viewport` is the PDF.js viewport
 * transform at scale 1 (user space → editor scene).
 */
export function createNativeText(unit: TextUnit, analysis: PageTextAnalysis, viewport: Matrix): NativeText {
  const used = [...new Set(unit.lines.flat().map((c) => c.font))];
  const fonts = used.map((index, i) => nativeFont(analysis.fonts[index], i));
  const fontOf = new Map(used.map((index, i) => [index, i]));

  const map = linear(viewport);
  const k = Math.sqrt(Math.abs(map[0] * map[3] - map[1] * map[2]));
  const colors = new Map<string, FillColor>();
  const style = (c: AnalyzedChar) => {
    const font = fonts[fontOf.get(c.font)!];
    const fill = colorToHex(c.color);
    if (!colors.has(fill)) colors.set(fill, c.color);
    return {
      fontFamily: font.css,
      fontSize: c.size * k,
      fill,
      fontWeight: font.bold ? "bold" : "normal",
      fontStyle: (font.italic ? "italic" : "normal") as "italic" | "normal",
      ...(c.rise ? { deltaY: -c.rise * k } : {}),
    };
  };

  // Text and per-character styles, by line (forced breaks) and character.
  let text = "";
  const styles: Record<number, Record<number, Record<string, unknown>>> = {};
  let line = 0;
  let column = 0;
  const put = (char: string, charStyle: Record<string, unknown>) => {
    (styles[line] ??= {})[column] = charStyle;
    text += char;
    column++;
  };
  unit.lines.forEach((chars, i) => {
    for (const c of chars) {
      const charStyle = style(c);
      for (const grapheme of Array.from(c.text)) put(grapheme, charStyle);
    }
    const join = unit.joins[i];
    if (join === "\n") {
      text += "\n";
      line++;
      column = 0;
    } else if (join === " " && chars.length > 0) {
      put(" ", style(chars.at(-1)!));
    }
  });

  const all = unit.lines.flat();
  const dominant = mostCommon(all, (c) => `${c.font}:${c.size.toFixed(2)}`);
  const base = style(dominant);
  const fill = mostCommon(all, (c) => colorToHex(c.color));

  // Orientation of the text on screen.
  const origin = applyToPoint(viewport, unit.origin[0], unit.origin[1]);
  const u = normalize(applyToPoint(map, unit.u[0], unit.u[1]));
  const v = normalize(applyToPoint(map, unit.v[0], unit.v[1]));
  const up: Point = [u[1], -u[0]];
  const mirrored = dot(v, up) < 0;
  const skew = mirrored ? 0 : (Math.atan2(dot(v, u), dot(v, up)) * 180) / Math.PI;
  const angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI;

  const data: NativeData = {
    unit: unit.id,
    kind: unit.kind,
    erase: unit.erase,
    insertAfter: unit.insertAfter,
    fonts,
    colors: [...colors],
    alpha: unit.alpha,
    renderMode: unit.renderMode,
    justifyLast: unit.justifyLast,
    lineCount: unit.lines.length,
    original: text,
    area: unit.quads,
  };

  const common = {
    ...base,
    fill: colorToHex(fill.color),
    styles,
    ytaNative: data,
    lineHeight: 1.16,
    opacity: unit.alpha,
    editingBorderColor: "#1976d2",
    cursorColor: "#1976d2",
    selectionColor: "rgba(25, 118, 210, 0.25)",
  };

  const block = unit.kind === "paragraph" || unit.align === "justify";
  let object: NativeText;
  if (block) {
    const sizeMult = 1.13;
    const width = Math.max(unit.width / (unit.hScale || 1), unit.naturalWidth) * k;
    object = new NativeBlock(text, {
      ...common,
      width: width * 1.002 + 0.01 * base.fontSize,
      textAlign: unit.align === "justify" ? "justify-left" : unit.align,
      lineHeight: unit.leading > 0 ? (unit.leading * k) / (base.fontSize * sizeMult) : 1.16,
      splitByGrapheme: false,
    });
  } else {
    object = new NativeLine(text, common);
  }

  object.set({
    angle,
    scaleX: unit.hScale || 1,
    scaleY: 1,
    skewX: Math.abs(skew) > 0.5 ? -skew : 0,
    flipY: mirrored,
  });
  placeBaseline(object, origin);
  return object;
}

/** Local point at the start of the first baseline (left edge of the box). */
function firstBaseline(object: unknown): Point {
  const text = internals(object);
  return [text._getLeftOffset(), text._getTopOffset() + text.getHeightOfLineImpl(0) * (1 - text._fontSizeFraction)];
}

/** Moves the object so the start of its first baseline lands on `target` (scene). */
export function placeBaseline(object: NativeText, target: Point): void {
  object.set({ left: 0, top: 0 });
  const local = firstBaseline(object);
  const current = applyToPoint(object.calcTransformMatrix() as Matrix, local[0], local[1]);
  object.set({ left: target[0] - current[0], top: target[1] - current[1] });
  object.setCoords();
}

// ── Editing helpers ────────────────────────────────────────────────────────

/**
 * Characters of the text that its original fonts cannot draw: the export
 * draws them with the closest standard font.
 */
export function substitutedChars(object: NativeText): string[] {
  const data = object.ytaNative;
  const missing = new Set<string>();
  const text = internals(object);
  for (let i = 0; i < text._textLines.length; i++) {
    text._textLines[i].forEach((char, j) => {
      if (/^\s+$/.test(char)) return;
      const font = originalFontFor(data, text.getCompleteStyleDeclaration(i, j));
      if (font && !font.glyphs[char]) missing.add(char);
    });
  }
  return [...missing];
}

/** Deleting native text keeps an invisible marker: the original stays erased. */
export function markDeleted(object: NativeText): void {
  object.set({ visible: false, evented: false, selectable: false, ytaNative: { ...object.ytaNative, deleted: true } } as never);
}

/** Turns a resize gesture into font sizes, keeping the horizontal scaling of the original. */
export function bakeNativeScale(object: NativeText): boolean {
  const factor = object.scaleY || 1;
  if (Math.abs(factor - 1) < 1e-3) return false;
  const scaleX = (object.scaleX || 1) / factor;
  const styles = object.styles as Record<number, Record<number, { fontSize?: number }>>;
  for (const line of Object.values(styles ?? {})) {
    for (const charStyle of Object.values(line)) {
      if (typeof charStyle.fontSize === "number") charStyle.fontSize *= factor;
    }
  }
  object.set({ fontSize: object.fontSize * factor, scaleX, scaleY: 1 });
  if (object instanceof NativeBlock) object.set("width", object.width * factor);
  object.initDimensions();
  object.setCoords();
  return true;
}

/**
 * Serialised native text copied elsewhere (paste, duplicate) becomes plain
 * text: its erasures only make sense on its own page.
 */
export function toPlainTextData(object: Record<string, unknown>): Record<string, unknown> {
  if (!isNativeData(object)) return object;
  const { ytaNative: _native, ...rest } = object;
  // Like any text added in the editor: one style for the whole object.
  return {
    ...rest,
    type: object.type === "NativeBlock" ? "Textbox" : "IText",
    fontFamily: plainFontFamily(String(object.fontFamily ?? "")),
    styles: [],
    textAlign: typeof object.textAlign === "string" && object.textAlign.startsWith("justify") ? "left" : object.textAlign,
    opacity: object.opacity ?? 1,
  };
}

// ── Export specs ───────────────────────────────────────────────────────────

// Fabric's underline geometry, as fractions of the font size (as in the export of plain text).
const UNDERLINE_OFFSET = 0.1;
const UNDERLINE_THICKNESS = 66.667 / 1000;

const colorKey = (color: FillColor) => `${color.space}:${color.components.map((c) => c.toFixed(4)).join(",")}`;

/**
 * What a native object asks of the PDF: the glyphs to erase and the text to
 * draw, laid out exactly as Fabric shows it. `drawText` false describes only
 * the erasure (while the object is being edited, the editor draws the text).
 */
export function nativeSpec(object: NativeText, viewport: Matrix, drawText = true): NativeSpec {
  const data = object.ytaNative;
  const spec: NativeSpec = {
    id: data.unit,
    erase: data.erase,
    insertAfter: data.insertAfter,
    matrix: [1, 0, 0, 1, 0, 0],
    renderMode: data.renderMode,
    runs: [],
    underlines: [],
  };
  if (!drawText || data.deleted || !object.visible || object.text.trim() === "") return spec;

  spec.matrix = objectToPdf(sceneToPdf(viewport), object.calcTransformMatrix() as Matrix);
  if (Math.abs((object.opacity ?? 1) - data.alpha) > 1e-3) spec.opacity = object.opacity ?? 1;

  const text = internals(object);
  const originalColors = new Map(data.colors);
  const runs = new Map<string, NativeRun>();
  const leftOffset = text._getLeftOffset();
  let lineTop = text._getTopOffset();

  for (let i = 0; i < text._textLines.length; i++) {
    const graphemes = text._textLines[i];
    const baseline = lineTop + text.getHeightOfLineImpl(i) * (1 - text._fontSizeFraction);
    const lineLeft = leftOffset + text._getLineLeftOffset(i);
    let underline: NativeUnderline | null = null;

    for (let j = 0; j < graphemes.length; j++) {
      const char = graphemes[j];
      const box = text.__charBounds[i]?.[j];
      if (!box) continue;
      const style = text.getCompleteStyleDeclaration(i, j);
      const size = Number(style.fontSize) || object.fontSize;
      const x = lineLeft + box.left;
      const y = -(baseline + (Number(style.deltaY) || 0));
      const hex = typeof style.fill === "string" ? style.fill.toLowerCase() : "#000000";
      const color = originalColors.get(hex) ?? hexToColor(hex);

      if (style.underline) {
        const thickness = size * UNDERLINE_THICKNESS;
        const rectY = -(baseline + size * UNDERLINE_OFFSET + thickness);
        const sameLine =
          underline && colorKey(underline.color) === colorKey(color) && Math.abs(underline.y - rectY) < 1e-6 && Math.abs(underline.thickness - thickness) < 1e-6;
        if (sameLine) underline!.width = x + box.width - underline!.x;
        else {
          underline = { color, x, y: rectY, width: box.width, thickness };
          spec.underlines.push(underline);
        }
      } else {
        underline = null;
      }

      const font = originalFontFor(data, style);
      const entry = font?.glyphs[char];

      let key: string;
      let glyph: NativeRun["glyphs"][number];
      let runFont: NativeRun["font"];
      if (font && entry) {
        key = `o${font.key}`;
        runFont = { kind: "original", sample: font.sample, key: font.key };
        glyph = { text: char, code: entry[0], length: entry[1], width: entry[2], x, y };
      } else {
        if (/^\s+$/.test(char)) continue;
        const family = String(style.fontFamily ?? "");
        const weight = String(style.fontWeight ?? "normal");
        const fontStyle = String(style.fontStyle ?? "normal");
        // The original font is still wanted, but lacks this character.
        const substitute = font !== undefined;
        key = `f${family}|${weight}|${fontStyle}|${substitute}`;
        runFont = { kind: "fallback", family, weight, style: fontStyle, ...(substitute ? { substitute } : {}) };
        glyph = { text: char, x, y };
      }
      const runKey = `${key}|${size.toFixed(4)}|${colorKey(color)}`;
      let run = runs.get(runKey);
      if (!run) {
        run = { font: runFont, size, color, glyphs: [] };
        runs.set(runKey, run);
      }
      run.glyphs.push(glyph);
    }
    lineTop += text.getHeightOfLine(i);
  }
  spec.runs = [...runs.values()];
  return spec;
}

/** Specs of the native objects in serialised annotations (for thumbnails and export). */
export async function nativeSpecsFromData(
  objects: Record<string, unknown>[],
  viewport: Matrix,
): Promise<NativeSpec[]> {
  const natives = objects.filter(isNativeData);
  if (natives.length === 0) return [];
  const enlivened = await util.enlivenObjects<FabricObject>(natives);
  return enlivened.filter(isNative).map((object) => nativeSpec(object, viewport));
}

/** Scene → user space for hit testing the analysis quads. */
export function toScene(viewport: Matrix, points: Point[]): Point[] {
  return points.map((p) => applyToPoint(viewport, p[0], p[1]));
}

export function pointInQuad(point: Point, quad: Point[], margin = 0): boolean {
  // Works for convex quads in either winding.
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    const edge: Point = [b[0] - a[0], b[1] - a[1]];
    const cross = edge[0] * (point[1] - a[1]) - edge[1] * (point[0] - a[0]);
    const distance = cross / (length(edge) || 1);
    if (Math.abs(distance) <= margin) continue;
    const s = Math.sign(distance);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
