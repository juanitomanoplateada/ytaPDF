import { StaticCanvas } from "fabric";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PageAnnotations, PageRef, SourceDocument } from "./editor.svelte";
import { ensureFontsFor } from "./embeddedFonts";
import type { Matrix } from "./geometry";
import { isNativeData, nativeSpecsFromData } from "./nativeText";
import { renderPage, viewportOf, type FormValue } from "./pdfjs";
import { specKey, textEditing } from "./pdfText/service";
import type { NativeSpec } from "./pdfText/types";

/**
 * Rendered page bitmaps, keyed by source page, rotation, form revision and
 * pixel width, so annotation changes only repaint the overlay instead of
 * re-rasterising the PDF page.
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

/** Specs for the document text edited on a page (empty if none). */
export async function pageSpecs(source: SourceDocument, page: PageRef, data: PageAnnotations | undefined): Promise<NativeSpec[]> {
  if (!data?.objects.some(isNativeData)) return [];
  const original = await source.pdf.getPage(page.sourceIndex + 1);
  return nativeSpecsFromData(data.objects, viewportOf(original, 1, page.rotation).transform as Matrix);
}

/**
 * The page to render: the original, or the page of a preview where the
 * edited document text is already applied. `done` releases the preview.
 */
export async function renderablePage(
  source: SourceDocument,
  page: PageRef,
  specs: NativeSpec[],
  formValues: Record<string, FormValue>,
): Promise<{ proxy: PDFPageProxy; done: () => void }> {
  if (specs.length === 0) return { proxy: await source.pdf.getPage(page.sourceIndex + 1), done: () => {} };
  const handle = textEditing.preview(source, page.sourceIndex, specs);
  try {
    const pdf = await handle.pdf;
    await textEditing.syncForms(pdf, formValues);
    return { proxy: await pdf.getPage(page.sourceIndex + 1), done: handle.release };
  } catch (error) {
    handle.release();
    throw error;
  }
}

/** Annotations Fabric still has to paint (edited document text is part of the page). */
export function withoutNativeText(data: PageAnnotations): PageAnnotations {
  return { ...data, objects: data.objects.filter((object) => !isNativeData(object)) };
}

async function pageBitmap(
  source: SourceDocument,
  page: PageRef,
  cssWidth: number,
  pixelRatio: number,
  formRevision: number,
  specs: NativeSpec[],
  formValues: Record<string, FormValue>,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const edits = specs.length > 0 ? specKey(specs) : "";
  const key = `${source.id}:${page.sourceIndex}:${page.rotation}:${formRevision}:${edits}:${Math.round(cssWidth * pixelRatio)}`;
  const cached = pageBitmaps.get(key);
  if (cached) return cached;

  const { proxy, done } = await renderablePage(source, page, specs, formValues);
  try {
    if (signal.aborted) return null;
    const scratch = document.createElement("canvas");
    const task = renderPage(proxy, scratch, cssWidth / page.width, pixelRatio, page.rotation);
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
  } finally {
    done();
  }
}

/** Paints Fabric annotation JSON onto `ctx`, `scale` device pixels per scene unit. */
export async function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  data: PageAnnotations,
  scale: number,
  signal?: AbortSignal,
): Promise<void> {
  await ensureFontsFor(data.objects);
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
  formRevision: number,
  formValues: Record<string, FormValue>,
  signal: AbortSignal,
): Promise<void> {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const specs = await pageSpecs(source, page, annotations);
  if (signal.aborted) return;
  const bitmap = await pageBitmap(source, page, cssWidth, pixelRatio, formRevision, specs, formValues, signal);
  if (!bitmap || signal.aborted) return;

  const scratch = document.createElement("canvas");
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) return;
  scratchCtx.drawImage(bitmap, 0, 0);
  const overlay = annotations ? withoutNativeText(annotations) : undefined;
  if (overlay && overlay.objects.length > 0) {
    await paintAnnotations(scratchCtx, overlay, bitmap.width / page.width, signal);
  }
  if (signal.aborted) return;

  canvas.width = scratch.width;
  canvas.height = scratch.height;
  canvas.getContext("2d")?.drawImage(scratch, 0, 0);
}
