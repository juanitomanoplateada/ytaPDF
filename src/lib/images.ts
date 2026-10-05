/**
 * Images placed on pages are kept as blob URLs. Fabric serialises only the URL,
 * so undo history stays cheap, and the export reads the original bytes back
 * from this registry instead of re-encoding what the canvas shows.
 */

export type EmbeddableMime = "image/png" | "image/jpeg";

export interface ImageAsset {
  bytes: Uint8Array;
  mime: EmbeddableMime;
}

const assets = new Map<string, ImageAsset>();

export function getImageAsset(url: string): ImageAsset | undefined {
  return assets.get(url);
}

/** Registers image bytes (for example, from a recovered session) under a new URL. */
export function registerImage(asset: ImageAsset): string {
  const url = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime }));
  assets.set(url, asset);
  return url;
}

export function releaseImageAssets(): void {
  for (const url of assets.keys()) URL.revokeObjectURL(url);
  assets.clear();
}

/** Longest side, in pixels, used when an image has to be re-encoded. */
const MAX_RASTER_SIDE = 4096;
/** Vector images are rasterised at least this large for print quality. */
const MIN_VECTOR_SIDE = 2048;

/**
 * Converts any image the browser can decode into PNG or JPEG bytes that
 * pdf-lib can embed, applying the EXIF orientation that browsers honour on
 * screen but that a raw JPEG stream would lose inside the PDF.
 */
export async function importImage(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImageType(bytes);

  let asset: ImageAsset;
  if (kind === "png") {
    asset = { bytes, mime: "image/png" };
  } else if (kind === "jpeg" && readJpegOrientation(bytes) <= 1) {
    asset = { bytes, mime: "image/jpeg" };
  } else {
    asset = await reencode(file, kind);
  }
  return registerImage(asset);
}

type ImageKind = "png" | "jpeg" | "svg" | "other";

export function sniffImageType(bytes: Uint8Array): ImageKind {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "svg";
  }
  return "other";
}

/** EXIF orientation (1–8) of a JPEG, or 1 when absent. */
export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return 1;
    const marker = view.getUint8(offset + 1);
    const length = view.getUint16(offset + 2);
    // Start of scan: no more metadata segments.
    if (marker === 0xda) return 1;
    if (marker === 0xe1 && offset + 10 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      if (tiff + 8 > view.byteLength) return 1;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > view.byteLength) return 1;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 10 > view.byteLength) return 1;
        if (view.getUint16(entry, little) === 0x0112) {
          const value = view.getUint16(entry + 8, little);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

async function reencode(file: Blob, kind: ImageKind): Promise<ImageAsset> {
  const image = await decodeImage(file);
  try {
    const isVector = kind === "svg";
    let width = image.width || 1024;
    let height = image.height || 1024;
    const longest = Math.max(width, height);
    const scale = isVector
      ? Math.max(1, MIN_VECTOR_SIDE / longest)
      : Math.min(1, MAX_RASTER_SIDE / longest);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo preparar la imagen.");
    ctx.drawImage(image.source, 0, 0, width, height);

    // Photos stay JPEG; anything that may carry transparency becomes PNG.
    const mime: EmbeddableMime = kind === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, 0.92),
    );
    if (!blob) throw new Error("No se pudo convertir la imagen.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
  } finally {
    image.release();
  }
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  // createImageBitmap applies EXIF orientation and decodes off the main thread,
  // but not every browser accepts SVG, so fall back to an <img> element.
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("El formato de la imagen no es compatible.");
    }
  }
}
