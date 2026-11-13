import { PDFDocument } from "@cantoo/pdf-lib";
import type { ImageAsset } from "./images";

/** Long side of an A4 page, in points. */
const LONG_SIDE = 841.89;

/**
 * Size of the page that holds an image: the image's proportions, with its
 * long side as long as an A4 page. Nothing is cropped and there are no bands.
 */
export function imagePageSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = LONG_SIDE / Math.max(w, h);
  return { width: Math.round(w * scale * 100) / 100, height: Math.round(h * scale * 100) / 100 };
}

/**
 * Builds a PDF with one page per image. The images are part of the page
 * content, as in a scanned document, so anything added later goes on top.
 */
export async function imagesToPdf(images: ImageAsset[], title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const asset of images) {
    const image = asset.mime === "image/png" ? await doc.embedPng(asset.bytes) : await doc.embedJpg(asset.bytes);
    const { width, height } = imagePageSize(image.width, image.height);
    const page = doc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  doc.setProducer("ytaPDF");
  doc.setCreator("ytaPDF");
  if (title) doc.setTitle(title);
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save({ useObjectStreams: true });
}
