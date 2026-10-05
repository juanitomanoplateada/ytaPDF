import {
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { objectToPdf, sceneToPdf, type Matrix } from "../geometry";
import { sanitizeForStandardFont, standardFontFor, type StandardFontName } from "../fonts";

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

export interface TextDrawable {
  kind: "text";
  /** Object-local (centred, y down) → scene transform, as Fabric computes it. */
  matrix: Matrix;
  lines: TextLine[];
  fontSize: number;
  fontFamily?: string;
  fontWeight?: string | number;
  fontStyle?: string;
  color: Rgb;
  opacity: number;
  underline: boolean;
}

export interface ImageDrawable {
  kind: "image";
  matrix: Matrix;
  src: string;
  width: number;
  height: number;
  opacity: number;
}

export type Drawable = TextDrawable | ImageDrawable;

export interface ImageData {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

// Fabric's underline geometry, as fractions of the font size.
const UNDERLINE_OFFSET = 0.1;
const UNDERLINE_THICKNESS = 66.667 / 1000;

/**
 * Shared state for drawing onto one output document: each font and image is
 * embedded once, however many objects use it.
 */
export class DrawContext {
  readonly unsupportedChars = new Set<string>();
  readonly failedImages = new Set<string>();
  readonly doc: PDFDocument;
  #loadImage: (src: string) => Promise<ImageData>;
  #fonts = new Map<StandardFontName, Promise<PDFFont>>();
  #images = new Map<string, Promise<PDFImage>>();

  constructor(doc: PDFDocument, loadImage: (src: string) => Promise<ImageData>) {
    this.doc = doc;
    this.#loadImage = loadImage;
  }

  font(name: StandardFontName): Promise<PDFFont> {
    let font = this.#fonts.get(name);
    if (!font) {
      font = this.doc.embedFont(name);
      this.#fonts.set(name, font);
    }
    return font;
  }

  image(src: string): Promise<PDFImage> {
    let image = this.#images.get(src);
    if (!image) {
      image = this.#loadImage(src).then(({ bytes, mime }) =>
        mime === "image/png" ? this.doc.embedPng(bytes) : this.doc.embedJpg(bytes),
      );
      this.#images.set(src, image);
    }
    return image;
  }
}

/**
 * Draws `drawables` onto `page`. `viewportTransform` is the PDF.js viewport
 * transform at scale 1 of the page the annotations were made on; inverting it
 * maps the editor's scene back to PDF user space, including the page's
 * rotation and crop box offset.
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
    if (drawable.kind === "text") {
      await drawText(page, drawable, matrix, context);
    } else {
      await drawImage(page, drawable, matrix, context);
    }
  }
}

async function drawText(
  page: PDFPage,
  text: TextDrawable,
  matrix: Matrix,
  context: DrawContext,
): Promise<void> {
  const font = await context.font(standardFontFor(text.fontFamily, text.fontWeight, text.fontStyle));
  const color = rgb(clamp01(text.color.r), clamp01(text.color.g), clamp01(text.color.b));
  const opacity = clamp01(text.opacity);

  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
  for (const line of text.lines) {
    // pdf-lib silently turns unencodable characters into "?", so they are
    // substituted (and reported) here, where better equivalents exist.
    const { text: content, unsupported } = sanitizeForStandardFont(line.text);
    for (const char of unsupported) context.unsupportedChars.add(char);
    if (content.length === 0) continue;

    // Content is laid out y-up here, so the y-down baseline changes sign.
    page.drawText(content, {
      x: line.x,
      y: -line.baseline,
      size: text.fontSize,
      font,
      color,
      opacity,
    });

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
  page.pushOperators(popGraphicsState());
}

async function drawImage(
  page: PDFPage,
  image: ImageDrawable,
  matrix: Matrix,
  context: DrawContext,
): Promise<void> {
  let embedded: PDFImage;
  try {
    embedded = await context.image(image.src);
  } catch (error) {
    console.error("No se pudo incrustar una imagen:", error);
    context.failedImages.add(image.src);
    return;
  }
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
  page.drawImage(embedded, {
    x: -image.width / 2,
    y: -image.height / 2,
    width: image.width,
    height: image.height,
    opacity: clamp01(image.opacity),
  });
  page.pushOperators(popGraphicsState());
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
