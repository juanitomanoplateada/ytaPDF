import type { FormValues, PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import { ensureFontsFor } from "../embeddedFonts";
import { MAX_CANVAS_PIXELS, renderPage } from "../pdfjs";
import { pageSpecs, paintAnnotations, renderablePage, withoutNativeText } from "../thumbnails";

export type RasterFormat = "image/png" | "image/jpeg";

export interface RasterOptions {
  /** Pixels per inch of the page. */
  dpi: number;
  format: RasterFormat;
  /** JPEG quality, 0–1. */
  quality?: number;
}

/**
 * Renders a page with its annotations and edited text into an image: what the
 * editor shows, without its selection handles. Pages with redactions are
 * exported this way, so nothing of their original content survives.
 */
export async function rasterizePage(
  page: PageRef,
  source: SourceDocument,
  data: PageAnnotations | undefined,
  formValues: FormValues,
  { dpi, format, quality = 0.92 }: RasterOptions,
): Promise<Uint8Array> {
  // Edited document text is already part of the preview page.
  const { proxy, done } = await renderablePage(source, page, await pageSpecs(source, page, data), formValues[source.id] ?? {});
  const scale = Math.min(dpi / 72, Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height)));
  const canvas = document.createElement("canvas");
  try {
    await renderPage(proxy, canvas, scale, 1, page).promise;
  } finally {
    done();
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo preparar la imagen de la página.");
  if (format === "image/jpeg") {
    // JPEG has no transparency: transparent areas would turn black.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }
  if (data && data.objects.length > 0) {
    // Notes and links are annotations of the file, not part of the page's image.
    const overlay = withoutNativeText({
      ...data,
      objects: data.objects.filter((object) => object.ytaKind !== "note" && object.ytaKind !== "link"),
    });
    await ensureFontsFor(overlay.objects);
    await paintAnnotations(ctx, overlay, canvas.width / page.width);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format, quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("No se pudo generar la imagen de la página.");
  return new Uint8Array(await blob.arrayBuffer());
}
