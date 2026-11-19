import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFPage } from "@cantoo/pdf-lib";
import type { FontCache } from "../pdfText/fonts";
import { interpretPage } from "../pdfText/interpreter";
import type { CompressionOptions } from "../compression";

export type { CompressionOptions } from "../compression";

/**
 * Makes the file smaller by re-encoding its JPEG images: at a lower quality,
 * and at a lower resolution when they are shown much smaller than they are.
 * pdf-lib copies images as they are, so this is done by hand: each JPEG the
 * pages draw is decoded and encoded again by the browser, and kept only if
 * the result is clearly smaller.
 */

export interface RecodeRequest {
  bytes: Uint8Array;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  quality: number;
}

/** Decodes a JPEG and encodes it again (as RGB) at the requested size, or returns null if it cannot. */
export type ImageRecoder = (request: RecodeRequest) => Promise<Uint8Array | null>;

export interface CompressionReport {
  /** Images re-encoded. */
  images: number;
  /** Their size before and after, in bytes. */
  before: number;
  after: number;
}

/** Re-encoding must save at least this share of an image to be kept. */
const MIN_SAVING = 0.1;
/** Images are only scaled down when they would lose at least this share of their width. */
const MIN_DOWNSCALE = 0.8;

function filterNames(dict: PDFDict): string[] {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const item = filter.lookup(i);
      if (item instanceof PDFName) names.push(item.decodeText());
    }
    return names;
  }
  return [];
}

const numberIn = (dict: PDFDict, key: string): number | undefined => {
  const value = dict.lookup(PDFName.of(key)) as { asNumber?: () => number } | undefined;
  return typeof value?.asNumber === "function" ? value.asNumber() : undefined;
};

/** Colour kind of a number of components (1 or 3), or null. */
const componentsKind = (n: number | undefined): "rgb" | "gray" | null => {
  if (n === 3) return "rgb";
  return n === 1 ? "gray" : null;
};

/** "rgb", "gray" or null for colour spaces a browser cannot be trusted to keep (CMYK, indexed…). */
function colorKind(dict: PDFDict): "rgb" | "gray" | null {
  const space = dict.lookup(PDFName.of("ColorSpace"));
  if (space instanceof PDFName) {
    const name = space.decodeText();
    if (name === "DeviceRGB") return "rgb";
    return name === "DeviceGray" ? "gray" : null;
  }
  if (!(space instanceof PDFArray)) return null;
  const family = space.lookup(0);
  const profile = space.lookup(1);
  if (!(family instanceof PDFName) || family.decodeText() !== "ICCBased" || !(profile instanceof PDFStream)) return null;
  return componentsKind(numberIn(profile.dict, "N"));
}

/** Whether an image is a plain 8-bit JPEG this module can re-encode without changing its colours. */
export function isRecodableJpeg(stream: PDFStream): boolean {
  const { dict } = stream;
  if (!(stream instanceof PDFRawStream)) return false;
  const filters = filterNames(dict);
  if (filters.length !== 1 || filters[0] !== "DCTDecode") return false;
  if (dict.lookup(PDFName.of("ImageMask"))?.toString() === "true") return false;
  if (dict.has(PDFName.of("Decode")) || dict.has(PDFName.of("SMaskInData"))) return false;
  if ((numberIn(dict, "BitsPerComponent") ?? 8) !== 8) return false;
  return colorKind(dict) !== null;
}

/** Largest size (points) each image is shown at on the pages, by object. */
function displaySizes(pages: PDFPage[], fonts: FontCache): Map<string, { ref: PDFRef; width: number; height: number }> {
  const sizes = new Map<string, { ref: PDFRef; width: number; height: number }>();
  for (const page of pages) {
    const content = interpretPage(page, fonts, { trackPaints: true });
    for (const paint of content.paints) {
      if (paint.kind !== "image" || !paint.ref) continue;
      const [p0, p1, , p3] = paint.points;
      const width = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const height = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
      const key = paint.ref.toString();
      const known = sizes.get(key);
      sizes.set(key, {
        ref: paint.ref,
        width: Math.max(width, known?.width ?? 0),
        height: Math.max(height, known?.height ?? 0),
      });
    }
  }
  return sizes;
}

/** Re-encodes the JPEG images drawn on `pages`. */
export async function compressImages(
  doc: PDFDocument,
  pages: PDFPage[],
  fonts: FontCache,
  options: CompressionOptions,
  recode: ImageRecoder,
): Promise<CompressionReport> {
  const report: CompressionReport = { images: 0, before: 0, after: 0 };
  for (const shown of displaySizes(pages, fonts).values()) {
    const result = await recompress(doc, shown, options, recode);
    if (!result) continue;
    report.images++;
    report.before += result.before;
    report.after += result.after;
  }
  return report;
}

/** Pixels an image needs to be shown at `maxDpi` where it is largest, never more than it has. */
function targetSize(width: number, height: number, shown: { width: number; height: number }, maxDpi: number) {
  const needed = Math.max(((shown.width / 72) * maxDpi) / width, ((shown.height / 72) * maxDpi) / height);
  const scale = needed < MIN_DOWNSCALE ? Math.max(needed, 16 / Math.min(width, height)) : 1;
  return {
    targetWidth: Math.max(1, Math.round(width * Math.min(1, scale))),
    targetHeight: Math.max(1, Math.round(height * Math.min(1, scale))),
  };
}

/** Re-encodes one image in place. Returns its sizes, or null when it was left as it was. */
async function recompress(
  doc: PDFDocument,
  shown: { ref: PDFRef; width: number; height: number },
  options: CompressionOptions,
  recode: ImageRecoder,
): Promise<{ before: number; after: number } | null> {
  const { context } = doc;
  const stream = context.lookup(shown.ref);
  if (!(stream instanceof PDFRawStream) || !isRecodableJpeg(stream)) return null;
  const width = numberIn(stream.dict, "Width") ?? 0;
  const height = numberIn(stream.dict, "Height") ?? 0;
  if (width <= 0 || height <= 0) return null;
  const { targetWidth, targetHeight } = targetSize(width, height, shown, options.maxDpi);

  const original = stream.getContents();
  let bytes: Uint8Array | null = null;
  try {
    bytes = await recode({ bytes: original, width, height, targetWidth, targetHeight, quality: options.quality });
  } catch (error) {
    console.error("No se pudo recomprimir una imagen:", error);
  }
  if (!bytes || bytes.length > original.length * (1 - MIN_SAVING)) return null;

  const dict = context.obj({});
  for (const [key, value] of stream.dict.entries()) {
    if (!REPLACED_KEYS.has(key.decodeText())) dict.set(key, value);
  }
  dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
  dict.set(PDFName.of("Width"), context.obj(targetWidth));
  dict.set(PDFName.of("Height"), context.obj(targetHeight));
  dict.set(PDFName.of("BitsPerComponent"), context.obj(8));
  // Browsers always encode three channels.
  if (colorKind(stream.dict) === "gray") dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  context.assign(shown.ref, PDFRawStream.of(dict, bytes));
  return { before: original.length, after: bytes.length };
}

/** Image dictionary entries the re-encoded copy writes anew. */
const REPLACED_KEYS = new Set(["Length", "Filter", "DecodeParms", "Width", "Height"]);

/** The browser's own decoder and encoder. */
export const browserRecoder: ImageRecoder = async ({ bytes, width, height, targetWidth, targetHeight, quality }) => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), {
    // PDF viewers ignore EXIF orientation and embedded profiles: so must the copy.
    imageOrientation: "none",
    colorSpaceConversion: "none",
  });
  try {
    if (bitmap.width !== width || bitmap.height !== height) return null;
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
};
