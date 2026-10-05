import type { PDFDocument } from "@cantoo/pdf-lib";
import type { FormValues, PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import { embeddedFontBytes, ensureFontsFor } from "../embeddedFonts";
import { getImageAsset, sniffImageType } from "../images";
import { MAX_CANVAS_PIXELS, renderPage, viewportOf } from "../pdfjs";
import { paintAnnotations } from "../thumbnails";
import { assembleDocument, type PagePlacement } from "./assemble";
import { DrawContext, drawOnPage, type FontkitLike, type ImageData } from "./drawing";
import { fabricToDrawables, hasRedactions } from "./fabricDrawables";

export interface ExportInput {
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  formValues: FormValues;
  sources: Map<string, SourceDocument>;
  title: string;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

/** Resolution used for pages that are flattened into an image by redaction. */
const RASTER_DPI = 200;

async function loadImage(src: string): Promise<ImageData> {
  const asset = getImageAsset(src);
  if (asset) return asset;
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
  const kind = sniffImageType(bytes);
  if (kind !== "png" && kind !== "jpeg") throw new Error("Formato de imagen no compatible.");
  return { bytes, mime: kind === "png" ? "image/png" : "image/jpeg" };
}

let fontkitModule: Promise<FontkitLike> | null = null;
function loadFontkit(): Promise<FontkitLike> {
  fontkitModule ??= import("@cantoo/fontkit").then((module) => (module.default ?? module) as unknown as FontkitLike);
  return fontkitModule;
}

/**
 * Renders a page with all its annotations into a JPEG. Used for pages with
 * redactions: nothing of the original page content survives in the file,
 * so the covered text cannot be recovered or copied.
 */
async function rasterizePage(page: PageRef, source: SourceDocument, data: PageAnnotations): Promise<Uint8Array> {
  const pdfPage = await source.pdf.getPage(page.sourceIndex + 1);
  const scale = Math.min(RASTER_DPI / 72, Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height)));
  const canvas = document.createElement("canvas");
  await renderPage(pdfPage, canvas, scale, 1, page.rotation).promise;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo preparar la página censurada.");
  await ensureFontsFor(data.objects);
  await paintAnnotations(ctx, data, canvas.width / page.width);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("No se pudo generar la imagen de la página censurada.");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportDocument(input: ExportInput): Promise<ExportResult> {
  const sourceOf = (page: PageRef) => {
    const source = input.sources.get(page.sourceId);
    if (!source) throw new Error("Falta el documento de origen.");
    return source;
  };

  // Redacted pages become images; everything else keeps its original content.
  const rasters = new Map<string, Uint8Array>();
  for (const page of input.pages) {
    const data = input.annotations[page.id];
    if (data && hasRedactions(data)) rasters.set(page.id, await rasterizePage(page, sourceOf(page), data));
  }

  const placements: PagePlacement[] = input.pages.map((page) =>
    rasters.has(page.id)
      ? { kind: "raster", width: page.width, height: page.height }
      : { sourceId: page.sourceId, sourceIndex: page.sourceIndex, rotation: page.rotation },
  );

  const fieldFont = async (doc: PDFDocument) => {
    doc.registerFontkit((await loadFontkit()) as never);
    return doc.embedFont(await embeddedFontBytes("noto-sans", "regular"), { subset: true });
  };
  const { doc, pages, inPlace, failedFields } = await assembleDocument(placements, input.sources, {
    formValues: input.formValues,
    fieldFont,
  });

  const context = new DrawContext(doc, {
    loadImage,
    loadFont: embeddedFontBytes,
    fontkit: await loadFontkit(),
  });

  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const raster = rasters.get(page.id);
    if (raster) {
      const image = await doc.embedJpg(raster);
      pages[i].drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
      continue;
    }
    const data = input.annotations[page.id];
    if (!data || data.objects.length === 0) continue;
    await ensureFontsFor(data.objects);
    const pdfjsPage = await sourceOf(page).pdf.getPage(page.sourceIndex + 1);
    const { transform } = viewportOf(pdfjsPage, 1, page.rotation);
    await drawOnPage(pages[i], await fabricToDrawables(data), transform, context);
  }

  const now = new Date();
  doc.setProducer("ytaPDF");
  doc.setModificationDate(now);
  if (!inPlace) {
    doc.setCreator("ytaPDF");
    doc.setCreationDate(now);
    if (!doc.getTitle()) doc.setTitle(input.title);
  }

  const bytes = await doc.save({ useObjectStreams: true });

  const warnings: string[] = [];
  if (context.unsupportedChars.size > 0) {
    const chars = [...context.unsupportedChars].slice(0, 12).join(" ");
    warnings.push(
      `Algunos caracteres no existen en las fuentes estándar del PDF y se sustituyeron por «?»: ${chars}. Usa Noto Sans o Noto Serif para conservarlos.`,
    );
  }
  if (context.missingGlyphs.size > 0) {
    const chars = [...context.missingGlyphs].slice(0, 12).join(" ");
    warnings.push(`La fuente elegida no tiene algunos caracteres y se sustituyeron por «?»: ${chars}`);
  }
  if (context.failedImages.size > 0) {
    warnings.push(
      context.failedImages.size === 1
        ? "Una imagen no se pudo incluir en el PDF."
        : `${context.failedImages.size} imágenes no se pudieron incluir en el PDF.`,
    );
  }
  if (failedFields.length > 0) {
    warnings.push(`No se pudieron rellenar algunos campos del formulario: ${failedFields.slice(0, 5).join(", ")}.`);
  }
  if (rasters.size > 0) {
    warnings.push(
      rasters.size === 1
        ? "La página con zonas censuradas se exportó como imagen: su texto ya no se puede seleccionar ni buscar."
        : `Las ${rasters.size} páginas con zonas censuradas se exportaron como imagen: su texto ya no se puede seleccionar ni buscar.`,
    );
  }
  return { bytes, warnings };
}
