import type { PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import { getImageAsset, sniffImageType } from "../images";
import { assembleDocument } from "./assemble";
import { DrawContext, drawOnPage, type ImageData } from "./drawing";
import { fabricToDrawables } from "./fabricDrawables";

export interface ExportInput {
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  sources: Map<string, SourceDocument>;
  title: string;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

async function loadImage(src: string): Promise<ImageData> {
  const asset = getImageAsset(src);
  if (asset) return asset;
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
  const kind = sniffImageType(bytes);
  if (kind !== "png" && kind !== "jpeg") throw new Error("Formato de imagen no compatible.");
  return { bytes, mime: kind === "png" ? "image/png" : "image/jpeg" };
}

export async function exportDocument(input: ExportInput): Promise<ExportResult> {
  const { doc, pages, inPlace } = await assembleDocument(input.pages, input.sources);
  const context = new DrawContext(doc, loadImage);

  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const data = input.annotations[page.id];
    if (!data || data.objects.length === 0) continue;

    const source = input.sources.get(page.sourceId);
    if (!source) throw new Error("Falta el documento de origen.");
    const pdfjsPage = await source.pdf.getPage(page.sourceIndex + 1);
    const { transform } = pdfjsPage.getViewport({ scale: 1 });
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
      `Algunos caracteres no existen en las fuentes estándar del PDF y se sustituyeron por «?»: ${chars}`,
    );
  }
  if (context.failedImages.size > 0) {
    warnings.push(
      context.failedImages.size === 1
        ? "Una imagen no se pudo incluir en el PDF."
        : `${context.failedImages.size} imágenes no se pudieron incluir en el PDF.`,
    );
  }
  return { bytes, warnings };
}
