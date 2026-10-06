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
  isWinAnsiChar,
  resolveFont,
  sanitizeForStandardFont,
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
  fontkit?: FontkitLike;
}

interface UsableFont {
  font: PDFFont;
  canEncode: (char: string) => boolean;
  embedded: boolean;
}

// Fabric's underline geometry, as fractions of the font size.
const UNDERLINE_OFFSET = 0.1;
const UNDERLINE_THICKNESS = 66.667 / 1000;

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

  async #embeddedFont(family: EmbeddedFamilyId, variant: FontVariant): Promise<UsableFont> {
    const { loadFont, fontkit } = this.#resources;
    if (!loadFont || !fontkit) throw new Error("Faltan los recursos para incrustar fuentes.");
    const bytes = await loadFont(family, variant);
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

  for (const line of text.lines) {
    // pdf-lib silently turns unencodable characters into "?", so they are
    // substituted (and reported) here, where better equivalents exist.
    const { text: content, unsupported } = sanitizeForStandardFont(line.text, canEncode);
    for (const char of unsupported) (embedded ? context.missingGlyphs : context.unsupportedChars).add(char);
    if (content.length === 0) continue;

    page.drawText(content, { x: line.x, y: -line.baseline, size: text.fontSize, font, color, opacity });

    if (text.underline && content.trim().length > 0) {
      const thickness = text.fontSize * UNDERLINE_THICKNESS;
      page.drawRectangle({
        x: line.x,
        y: -(line.baseline + text.fontSize * UNDERLINE_OFFSET + thickness),
        width: font.widthOfTextAtSize(content, text.fontSize),
        height: thickness,
        color,
        opacity,
        borderWidth: 0,
      });
    }
  }
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
