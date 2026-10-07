import type { PDFDocument } from "@cantoo/pdf-lib";
import type { FormValues, PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import { embeddedFontBytes, ensureFontsFor } from "../embeddedFonts";
import { getImageAsset, sniffImageType } from "../images";
import { MAX_CANVAS_PIXELS, renderPage, viewportOf } from "../pdfjs";
import { applyNativeSpecs } from "../pdfText/apply";
import { fallbackResources } from "../pdfText/fallback";
import { FontCache } from "../pdfText/fonts";
import { pageSpecs, paintAnnotations, renderablePage, withoutNativeText } from "../thumbnails";
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
async function rasterizePage(
  page: PageRef,
  source: SourceDocument,
  data: PageAnnotations,
  formValues: FormValues,
): Promise<Uint8Array> {
  // Edited document text is already part of the preview page.
  const { proxy, done } = await renderablePage(source, page, await pageSpecs(source, page, data), formValues[source.id] ?? {});
  const scale = Math.min(RASTER_DPI / 72, Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height)));
  const canvas = document.createElement("canvas");
  try {
    await renderPage(proxy, canvas, scale, 1, page.rotation).promise;
  } finally {
    done();
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo preparar la página censurada.");
  const overlay = withoutNativeText(data);
  await ensureFontsFor(overlay.objects);
  await paintAnnotations(ctx, overlay, canvas.width / page.width);
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
    if (data && hasRedactions(data)) rasters.set(page.id, await rasterizePage(page, sourceOf(page), data, input.formValues));
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
  const fonts = new FontCache(doc.context);
  const failedText: string[] = [];
  const substituted = new Set<string>();

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
    // Document text first: it rewrites the page content, which annotations are drawn on top of.
    const specs = await pageSpecs(sourceOf(page), page, data);
    if (specs.length > 0) {
      const report = await applyNativeSpecs(pages[i], specs, fonts, fallbackResources(context));
      failedText.push(...report.failed);
      for (const run of specs.flatMap((spec) => spec.runs)) {
        if (run.font.kind === "fallback" && run.font.substitute) {
          for (const glyph of run.glyphs) substituted.add(glyph.text);
        }
      }
    }
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
  const warnings = exportWarnings(context, failedFields, rasters.size, failedText.length);
  if (substituted.size > 0) {
    warnings.unshift(
      `Algunos caracteres no existen en la fuente original del documento y se dibujaron con una fuente parecida: ${[...substituted].slice(0, 12).join(" ")}`,
    );
  }
  return { bytes, warnings };
}

/** What the exported file could not keep exactly as the editor showed it. */
function exportWarnings(context: DrawContext, failedFields: string[], rasterCount: number, failedText: number): string[] {
  const warnings: string[] = [];
  if (failedText > 0) {
    warnings.push(
      failedText === 1
        ? "Un texto editado del documento no se pudo aplicar y se dejó como estaba."
        : `${failedText} textos editados del documento no se pudieron aplicar y se dejaron como estaban.`,
    );
  }
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
  if (rasterCount > 0) {
    warnings.push(
      rasterCount === 1
        ? "La página con zonas censuradas se exportó como imagen: su texto ya no se puede seleccionar ni buscar."
        : `Las ${rasterCount} páginas con zonas censuradas se exportaron como imagen: su texto ya no se puede seleccionar ni buscar.`,
    );
  }
  return warnings;
}
