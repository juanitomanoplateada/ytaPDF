import { StaticCanvas } from "fabric";
import type { PageAnnotations, PageRef, SourceDocument } from "./editor.svelte";
import { renderPage } from "./pdfjs";

/**
 * Rendered page bitmaps, keyed by source page and pixel width, so annotation
 * changes only repaint the overlay instead of re-rasterising the PDF page.
 */
const pageBitmaps = new Map<string, ImageBitmap>();
const CACHE_LIMIT = 150;

export function clearThumbnailCache(): void {
  for (const bitmap of pageBitmaps.values()) bitmap.close();
  pageBitmaps.clear();
}

function remember(key: string, bitmap: ImageBitmap): void {
  pageBitmaps.set(key, bitmap);
  while (pageBitmaps.size > CACHE_LIMIT) {
    const oldest = pageBitmaps.keys().next().value as string;
    pageBitmaps.get(oldest)?.close();
    pageBitmaps.delete(oldest);
  }
}

async function pageBitmap(
  source: SourceDocument,
  page: PageRef,
  cssWidth: number,
  pixelRatio: number,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const key = `${source.id}:${page.sourceIndex}:${Math.round(cssWidth * pixelRatio)}`;
  const cached = pageBitmaps.get(key);
  if (cached) return cached;

  const pdfPage = await source.pdf.getPage(page.sourceIndex + 1);
  if (signal.aborted) return null;
  const scratch = document.createElement("canvas");
  const task = renderPage(pdfPage, scratch, cssWidth / page.width, pixelRatio);
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bitmap = await createImageBitmap(scratch);
  remember(key, bitmap);
  return bitmap;
}

/** Paints Fabric annotation JSON onto `ctx`, `scale` device pixels per scene unit. */
export async function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  data: PageAnnotations,
  scale: number,
  signal?: AbortSignal,
): Promise<void> {
  const element = document.createElement("canvas");
  const overlay = new StaticCanvas(element, {
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  try {
    await overlay.loadFromJSON(data, undefined, { signal });
    overlay.setZoom(scale);
    overlay.renderAll();
    ctx.drawImage(overlay.getElement(), 0, 0);
  } finally {
    void overlay.dispose();
  }
}

/**
 * Draws a page thumbnail with its annotations into `canvas`, which is only
 * touched once everything is ready so updates never flash.
 */
export async function renderThumbnail(
  canvas: HTMLCanvasElement,
  source: SourceDocument,
  page: PageRef,
  cssWidth: number,
  annotations: PageAnnotations | undefined,
  signal: AbortSignal,
): Promise<void> {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const bitmap = await pageBitmap(source, page, cssWidth, pixelRatio, signal);
  if (!bitmap || signal.aborted) return;

  const scratch = document.createElement("canvas");
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) return;
  scratchCtx.drawImage(bitmap, 0, 0);
  if (annotations && annotations.objects.length > 0) {
    await paintAnnotations(scratchCtx, annotations, bitmap.width / page.width, signal);
  }
  if (signal.aborted) return;

  canvas.width = scratch.width;
  canvas.height = scratch.height;
  canvas.getContext("2d")?.drawImage(scratch, 0, 0);
}
