import {
  concatTransformationMatrix,
  LineCapStyle,
  LineJoinStyle,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineJoin,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { objectToPdf, sceneToPdf, type Matrix } from "../geometry";
import {
  isBoldWeight,
  isWinAnsiChar,
  resolveFont,
  sanitizeForStandardFont,
  scriptFontFor,
  type ScriptFontId,
  type EmbeddedFamilyId,
  type FontVariant,
  type FontWeight,
  type ResolvedFont,
} from "../fonts";

/** A text line positioned in the object's local space (centred, y down). */
export interface TextLine {
  text: string;
  /** Left edge of the line. */
  x: number;
  /** Alphabetic baseline of the line. */
  baseline: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Placed {
  /** Object-local (centred, y down) → scene transform, as Fabric computes it. */
  matrix: Matrix;
  opacity: number;
}

export interface TextDrawable extends Placed {
  kind: "text";
  lines: TextLine[];
  fontSize: number;
  fontFamily?: string;
  fontWeight?: FontWeight;
  fontStyle?: string;
  color: Rgb;
  underline: boolean;
  linethrough?: boolean;
}

export interface ImageDrawable extends Placed {
  kind: "image";
  src: string;
  width: number;
  height: number;
}

/** Stroked or filled SVG path in local coordinates (y down). */
export interface PathDrawable extends Placed {
  kind: "path";
  d: string;
  stroke: Rgb | null;
  strokeWidth: number;
  fill: Rgb | null;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
}

/** Rectangle centred on the local origin. */
export interface RectDrawable extends Placed {
  kind: "rect";
  width: number;
  height: number;
  fill: Rgb | null;
  stroke: Rgb | null;
  strokeWidth: number;
}

/** Ellipse centred on the local origin. */
export interface EllipseDrawable extends Placed {
  kind: "ellipse";
  rx: number;
  ry: number;
  fill: Rgb | null;
  stroke: Rgb | null;
  strokeWidth: number;
}

export type Drawable = TextDrawable | ImageDrawable | PathDrawable | RectDrawable | EllipseDrawable;

export interface ImageData {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

/** The subset of fontkit the export needs, to check glyph coverage. */
export interface FontkitLike {
  create(bytes: Uint8Array): { hasGlyphForCodePoint(codePoint: number): boolean };
}

export interface DrawResources {
  loadImage: (src: string) => Promise<ImageData>;
  /** Font file bytes for embedded families; required only if they are used. */
  loadFont?: (family: EmbeddedFamilyId, variant: FontVariant) => Promise<Uint8Array>;
  /** Font file bytes for scripts the families lack (Arabic, Chinese, Japanese, Korean). */
  loadScriptFont?: (id: ScriptFontId, bold: boolean) => Promise<Uint8Array>;
  fontkit?: FontkitLike;
}

interface UsableFont {
  font: PDFFont;
  canEncode: (char: string) => boolean;
  embedded: boolean;
}

// Fabric's text decoration geometry, as fractions of the font size: offsets
// from the baseline (y down) and the line thickness. A strikethrough is
// centred on its offset; an underline hangs from it.
const UNDERLINE_OFFSET = 0.1;
const LINETHROUGH_OFFSET = -0.28167;
const DECORATION_THICKNESS = 66.667 / 1000;

/**
 * Shared state for drawing onto one output document: each font and image is
 * embedded once, however many objects use it.
 */
export class DrawContext {
  /** Characters missing from the standard fonts. */
  readonly unsupportedChars = new Set<string>();
  /** Characters missing from an embedded font. */
  readonly missingGlyphs = new Set<string>();
  readonly failedImages = new Set<string>();
  readonly doc: PDFDocument;
  readonly #resources: DrawResources;
  readonly #fonts = new Map<string, Promise<UsableFont>>();
  readonly #images = new Map<string, Promise<PDFImage>>();

  constructor(doc: PDFDocument, resources: DrawResources) {
    this.doc = doc;
    this.#resources = resources;
  }

  font(resolved: ResolvedFont): Promise<UsableFont> {
    const key = resolved.kind === "standard" ? resolved.name : `${resolved.family}:${resolved.variant}`;
    let font = this.#fonts.get(key);
    if (!font) {
      font = resolved.kind === "standard" ? this.#standardFont(resolved.name) : this.#embeddedFont(resolved.family, resolved.variant);
      this.#fonts.set(key, font);
    }
    return font;
  }

  async #standardFont(name: string): Promise<UsableFont> {
    return { font: await this.doc.embedFont(name), canEncode: isWinAnsiChar, embedded: false };
  }

  /** The font for characters of a script the text's own font lacks, or null if none can be had. */
  scriptFont(id: ScriptFontId, bold: boolean): Promise<UsableFont | null> {
    const { loadScriptFont, fontkit } = this.#resources;
    if (!loadScriptFont || !fontkit) return Promise.resolve(null);
    const key = `script:${id}:${bold}`;
    let font = this.#fonts.get(key);
    if (!font) {
      font = loadScriptFont(id, bold).then((bytes) => this.#fromBytes(bytes));
      this.#fonts.set(key, font);
    }
    return font.catch((error) => {
      console.error("No se pudo cargar la fuente para otros alfabetos:", error);
      return null;
    });
  }

  async #embeddedFont(family: EmbeddedFamilyId, variant: FontVariant): Promise<UsableFont> {
    const { loadFont, fontkit } = this.#resources;
    if (!loadFont || !fontkit) throw new Error("Faltan los recursos para incrustar fuentes.");
    return this.#fromBytes(await loadFont(family, variant));
  }

  async #fromBytes(bytes: Uint8Array): Promise<UsableFont> {
    const { fontkit } = this.#resources;
    if (!fontkit) throw new Error("Faltan los recursos para incrustar fuentes.");
    this.doc.registerFontkit(fontkit as never);
    const font = await this.doc.embedFont(bytes, { subset: true });
    const glyphs = fontkit.create(bytes);
    const canEncode = (char: string) => {
      const codePoint = char.codePointAt(0);
      return codePoint !== undefined && glyphs.hasGlyphForCodePoint(codePoint);
    };
    return { font, canEncode, embedded: true };
  }

  image(src: string): Promise<PDFImage> {
    let image = this.#images.get(src);
    if (!image) {
      image = this.#resources.loadImage(src).then(({ bytes, mime }) =>
        mime === "image/png" ? this.doc.embedPng(bytes) : this.doc.embedJpg(bytes),
      );
      this.#images.set(src, image);
    }
    return image;
  }
}

/**
 * Draws `drawables` onto `page`. `viewportTransform` is the PDF.js viewport
 * transform at scale 1 of the page as the editor showed it; inverting it maps
 * the editor's scene back to PDF user space, including the page's rotation
 * and crop box offset.
 */
export async function drawOnPage(
  page: PDFPage,
  drawables: Drawable[],
  viewportTransform: number[],
  context: DrawContext,
): Promise<void> {
  const toPdf = sceneToPdf(viewportTransform);
  for (const drawable of drawables) {
    const matrix = objectToPdf(toPdf, drawable.matrix);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
    switch (drawable.kind) {
      case "text":
        await drawText(page, drawable, context);
        break;
      case "image":
        await drawImage(page, drawable, context);
        break;
      case "path":
        drawPath(page, drawable);
        break;
      case "rect":
        drawRect(page, drawable);
        break;
      case "ellipse":
        drawEllipse(page, drawable);
        break;
    }
    page.pushOperators(popGraphicsState());
  }
}

// Everything below draws in the object's local space with y pointing up, so
// y-down Fabric coordinates change sign.

async function drawText(page: PDFPage, text: TextDrawable, context: DrawContext): Promise<void> {
  const { font, canEncode, embedded } = await context.font(
    resolveFont(text.fontFamily, text.fontWeight, text.fontStyle),
  );
  const color = toColor(text.color);
  const opacity = clamp01(text.opacity);

  const primary = { font, canEncode, embedded };
  const bold = isBoldWeight(text.fontWeight);

  for (const line of text.lines) {
    const runs = await textRuns(line.text, primary, bold, context);
    let x = line.x;
    let width = 0;
    let visible = false;
    for (const run of runs) {
      page.drawText(run.text, { x, y: -line.baseline, size: text.fontSize, font: run.font, color, opacity });
      const advance = run.font.widthOfTextAtSize(run.text, text.fontSize);
      x += advance;
      width += advance;
      if (run.text.trim()) visible = true;
    }

    if (!visible) continue;
    const thickness = text.fontSize * DECORATION_THICKNESS;
    // drawRectangle takes the bottom edge, which in y-down terms is the larger y.
    const decorate = (bottom: number) =>
      page.drawRectangle({ x: line.x, y: -bottom, width, height: thickness, color, opacity, borderWidth: 0 });
    if (text.underline) decorate(line.baseline + text.fontSize * UNDERLINE_OFFSET + thickness);
    if (text.linethrough) decorate(line.baseline + text.fontSize * LINETHROUGH_OFFSET + thickness / 2);
  }
}

interface TextRun {
  text: string;
  font: PDFFont;
}

/**
 * Splits a line into runs that one font can draw: the text's own font, or a
 * script font for Arabic, Chinese, Japanese and Korean characters it lacks.
 * Spaces and punctuation stay with the run they are in. Runs keep the line's
 * order (the canvas lays lines out left to right too); fontkit shapes Arabic
 * and gives its glyphs right to left within each run.
 */
async function textRuns(text: string, primary: UsableFont, bold: boolean, context: DrawContext): Promise<TextRun[]> {
  const runs: { text: string; font: UsableFont }[] = [];
  const push = (char: string, font: UsableFont) => {
    const last = runs.at(-1);
    if (last && last.font === font) last.text += char;
    else runs.push({ text: char, font });
  };
  for (const char of text) {
    const current = runs.at(-1)?.font;
    // Neutral characters continue the current run when its font has them.
    if (current && current !== primary && /[\s\p{P}\p{N}]/u.test(char) && current.canEncode(char)) {
      push(char, current);
      continue;
    }
    if (primary.canEncode(char)) {
      push(char, primary);
      continue;
    }
    const scriptId = scriptFontFor(char);
    const script = scriptId ? await context.scriptFont(scriptId, bold) : null;
    if (script?.canEncode(char)) {
      push(char, script);
      continue;
    }
    // pdf-lib silently turns unencodable characters into "?", so they are
    // substituted (and reported) here, where better equivalents exist.
    const { text: substitute, unsupported } = sanitizeForStandardFont(char, primary.canEncode);
    for (const missing of unsupported) (primary.embedded ? context.missingGlyphs : context.unsupportedChars).add(missing);
    push(substitute, primary);
  }
  return runs.filter((run) => run.text.length > 0).map((run) => ({ text: run.text, font: run.font.font }));
}

async function drawImage(page: PDFPage, image: ImageDrawable, context: DrawContext): Promise<void> {
  let embedded: PDFImage;
  try {
    embedded = await context.image(image.src);
  } catch (error) {
    console.error("No se pudo incrustar una imagen:", error);
    context.failedImages.add(image.src);
    return;
  }
  page.drawImage(embedded, {
    x: -image.width / 2,
    y: -image.height / 2,
    width: image.width,
    height: image.height,
    opacity: clamp01(image.opacity),
  });
}

const LINE_CAPS = { butt: LineCapStyle.Butt, round: LineCapStyle.Round, square: LineCapStyle.Projecting };
const LINE_JOINS = { miter: LineJoinStyle.Miter, round: LineJoinStyle.Round, bevel: LineJoinStyle.Bevel };

function drawPath(page: PDFPage, path: PathDrawable): void {
  if (!path.stroke && !path.fill) return;
  const opacity = clamp01(path.opacity);
  page.pushOperators(setLineJoin(LINE_JOINS[path.lineJoin]));
  // drawSvgPath flips y itself, which turns this y-up space back into the
  // y-down space the path was written in.
  page.drawSvgPath(path.d, {
    x: 0,
    y: 0,
    ...(path.fill ? { color: toColor(path.fill), opacity } : {}),
    ...(path.stroke
      ? {
          borderColor: toColor(path.stroke),
          borderWidth: path.strokeWidth,
          borderOpacity: opacity,
          borderLineCap: LINE_CAPS[path.lineCap],
        }
      : {}),
  });
}

function fillAndStroke(shape: RectDrawable | EllipseDrawable) {
  const opacity = clamp01(shape.opacity);
  const stroke = shape.stroke && shape.strokeWidth > 0 ? shape.stroke : null;
  return {
    visible: !!shape.fill || !!stroke,
    options: {
      ...(shape.fill ? { color: toColor(shape.fill), opacity } : {}),
      ...(stroke ? { borderColor: toColor(stroke), borderWidth: shape.strokeWidth, borderOpacity: opacity } : { borderWidth: 0 }),
    },
  };
}

function drawRect(page: PDFPage, rect: RectDrawable): void {
  const { visible, options } = fillAndStroke(rect);
  if (!visible) return;
  page.drawRectangle({ x: -rect.width / 2, y: -rect.height / 2, width: rect.width, height: rect.height, ...options });
}

function drawEllipse(page: PDFPage, ellipse: EllipseDrawable): void {
  const { visible, options } = fillAndStroke(ellipse);
  if (!visible) return;
  page.drawEllipse({ x: 0, y: 0, xScale: ellipse.rx, yScale: ellipse.ry, ...options });
}

function toColor({ r, g, b }: Rgb): Color {
  return rgb(clamp01(r), clamp01(g), clamp01(b));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
