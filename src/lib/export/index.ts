import type { PDFDocument, PDFPage } from "@cantoo/pdf-lib";
import type { FormValues, PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import { embeddedFontBytes, ensureFontsFor, scriptFontBytes } from "../embeddedFonts";
import { t } from "../i18n.svelte";
import { getImageAsset, sniffImageType } from "../images";
import { viewportOf } from "../pdfjs";
import { applyNativeSpecs } from "../pdfText/apply";
import { fallbackResources } from "../pdfText/fallback";
import { FontCache } from "../pdfText/fonts";
import { pageSpecs } from "../thumbnails";
import {
  applyMetadata,
  assembleDocument,
  flattenForm,
  protectDocument,
  removeUnreachableObjects,
  stripMetadata,
  type DocumentMetadata,
  type PagePlacement,
} from "./assemble";
import { DrawContext, drawOnPage, type FontkitLike, type ImageData } from "./drawing";
import { fabricToDrawables, hasRedactions, redactionAreas, sceneAnnotations } from "./fabricDrawables";
import { addPageAnnotations, type PageAnnotation, type UserRect } from "./pdfAnnotations";
import { browserRecoder, compressImages, type CompressionReport, type ImageRecoder } from "./compress";
import type { CompressionOptions } from "../compression";
import { redactPage } from "./redact";
import { applyToPoint, IDENTITY, multiply, sceneToPdf, type Matrix } from "../geometry";
import { ocrKey, toSceneQuad, type OcrPage } from "../ocrText";
import { addInvisibleText } from "./ocrLayer";
import { addSignaturePlaceholder, describeCertificate, readPkcs12, signSavedPdf } from "./sign";

export { CertificateError } from "./sign";
import { overlapArea, type Point } from "../polygon";
import { rasterizePage } from "./raster";
import { writeOutline } from "./outline";
import type { OutlineEntry } from "../outline";

export type { DocumentMetadata } from "./assemble";

export interface ExportInput {
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  formValues: FormValues;
  sources: Map<string, SourceDocument>;
  title: string;
  /** Encrypts the file (AES-256) so it only opens with this password. */
  password?: string;
  /** Turns form fields into page content, so they can no longer be changed. */
  flattenForms?: boolean;
  /** Properties written instead of the original ones. */
  metadata?: DocumentMetadata;
  /** Removes every property of the document (title, author, dates, software). */
  stripMetadata?: boolean;
  /** Bookmarks of the exported file. A document edited in place keeps its own. */
  outline?: OutlineEntry[];
  /** Re-encodes the document's JPEG images to make the file smaller. */
  compression?: CompressionOptions;
  /** Image re-encoder (the browser's by default). */
  recodeImage?: ImageRecoder;
  /** Text recognised on scanned pages (by source page), written as invisible text. */
  ocr?: Record<string, OcrPage>;
  /** Signs the file with the user's certificate. Not compatible with `password`. */
  signature?: SignatureRequest;
}

export interface SignatureRequest {
  /** PKCS#12 file (.p12, .pfx). */
  certificate: Uint8Array;
  password: string;
  reason?: string;
  location?: string;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
  /** What image recompression achieved, when it was requested. */
  compression?: CompressionReport;
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
 * Builds the exported file. `forcedRaster` lists pages to export as an image
 * (pages whose redaction could not be done on their content).
 */
export async function exportDocument(input: ExportInput, forcedRaster: ReadonlySet<string> = new Set()): Promise<ExportResult> {
  // The certificate is checked first: a wrong password fails before any work.
  const identity = input.signature ? readPkcs12(input.signature.certificate, input.signature.password) : null;
  if (identity && input.password) throw new Error("Un documento firmado no se puede cifrar con contraseña.");

  const sourceOf = (page: PageRef) => {
    const source = input.sources.get(page.sourceId);
    if (!source) throw new Error("Falta el documento de origen.");
    return source;
  };

  // What lies under redaction boxes is removed from the page's content. Pages
  // where that cannot be done exactly are exported as an image instead.
  const redactions = new Map<string, Point[][]>();
  const rasterIds = new Set(forcedRaster);
  for (const page of input.pages) {
    const data = input.annotations[page.id];
    if (!data || !hasRedactions(data)) continue;
    const { areas, coversContent } = await redactionAreas(data);
    redactions.set(page.id, areas);
    if (coversContent) rasterIds.add(page.id);
  }
  const rasters = new Map<string, Uint8Array>();
  for (const page of input.pages) {
    if (!rasterIds.has(page.id)) continue;
    rasters.set(
      page.id,
      await rasterizePage(page, sourceOf(page), input.annotations[page.id], input.formValues, {
        dpi: RASTER_DPI,
        format: "image/jpeg",
      }),
    );
  }

  const placements: PagePlacement[] = input.pages.map((page) =>
    rasters.has(page.id)
      ? { kind: "raster", width: page.width, height: page.height }
      : { sourceId: page.sourceId, sourceIndex: page.sourceIndex, rotation: page.rotation, crop: page.crop },
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
    loadScriptFont: scriptFontBytes,
    fontkit: await loadFontkit(),
  });
  const fonts = new FontCache(doc.context);
  const failedText: string[] = [];
  const substituted = new Set<string>();

  // Document text first: it rewrites the page content, which the flattened
  // fields and the annotations are then drawn on top of.
  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const data = input.annotations[page.id];
    if (rasters.has(page.id) || !data || data.objects.length === 0) continue;
    const specs = await pageSpecs(sourceOf(page), page, data);
    if (specs.length === 0) continue;
    const report = await applyNativeSpecs(pages[i], specs, fonts, fallbackResources(context));
    failedText.push(...report.failed);
    for (const run of specs.flatMap((spec) => spec.runs)) {
      if (run.font.kind === "fallback" && run.font.substitute) {
        for (const glyph of run.glyphs) substituted.add(glyph.text);
      }
    }
  }

  if (input.flattenForms) flattenForm(doc);

  // Redaction comes after the edited text and the flattened fields, so both
  // are cut as well.
  const unredactable: string[] = [];
  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const areas = redactions.get(page.id);
    if (!areas || rasterIds.has(page.id)) continue;
    const pdfjsPage = await sourceOf(page).pdf.getPage(page.sourceIndex + 1);
    const toPdf = sceneToPdf(viewportOf(pdfjsPage, 1, page).transform);
    const userAreas = areas.map((area) => area.map(([x, y]) => applyToPoint(toPdf, x, y)));
    const outcome = await redactPage(pages[i], userAreas, fonts, fallbackResources(context));
    if (!outcome.done) unredactable.push(page.id);
  }
  if (unredactable.length > 0) return exportDocument(input, new Set([...rasterIds, ...unredactable]));

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
    const { transform } = viewportOf(pdfjsPage, 1, page);
    const drawables = await fabricToDrawables(data);
    if (drawables.length === 0) continue;
    isolateContent(pages[i]);
    await drawOnPage(pages[i], drawables, transform, context);
  }

  // Recognised text of scanned pages, invisible over the picture of each word.
  let ocrFont: Awaited<ReturnType<DrawContext["font"]>> | null = null;
  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const recognised = input.ocr?.[ocrKey(page.sourceId, page.sourceIndex)];
    if (!recognised || recognised.lines.length === 0) continue;
    const pdfjsPage = await sourceOf(page).pdf.getPage(page.sourceIndex + 1);
    const viewport = viewportOf(pdfjsPage, 1, page).transform as Matrix;
    // Raster pages have their own space: the editor's scene, upside down.
    const toPage: Matrix = rasters.has(page.id) ? multiply([1, 0, 0, -1, 0, page.height], viewport) : IDENTITY;
    const hidden = redactions.get(page.id) ?? [];
    const words = recognised.lines
      .flatMap((line) => line.words)
      .filter((word) => !hidden.some((area) => overlapArea(toSceneQuad(word.quad, viewport), area) > 0))
      .map((word) => ({ text: word.text, quad: word.quad.map(([x, y]) => applyToPoint(toPage, x, y)) }));
    if (words.length === 0) continue;
    ocrFont ??= await context.font({ kind: "embedded", family: "noto-sans", variant: "regular" });
    isolateContent(pages[i]);
    addInvisibleText(pages[i], words, ocrFont.font, ocrFont.canEncode);
  }

  // Notes and links, as annotations other readers can open and follow.
  const indexOfPage = new Map(input.pages.map((page, i) => [page.id, i]));
  let droppedLinks = 0;
  for (let i = 0; i < input.pages.length; i++) {
    const page = input.pages[i];
    const data = input.annotations[page.id];
    if (!data) continue;
    const found = await sceneAnnotations(data);
    if (found.length === 0) continue;
    let toPdf: Matrix;
    if (rasters.has(page.id)) {
      toPdf = [1, 0, 0, -1, 0, page.height];
    } else {
      const pdfjsPage = await sourceOf(page).pdf.getPage(page.sourceIndex + 1);
      toPdf = sceneToPdf(viewportOf(pdfjsPage, 1, page).transform);
    }
    const hidden = redactions.get(page.id) ?? [];
    const list: PageAnnotation[] = [];
    for (const item of found) {
      // Whatever a redaction box covers is gone, notes and links included.
      if (hidden.some((area) => overlapArea(item.corners, area) > 0.5)) continue;
      const points = item.corners.map(([x, y]) => applyToPoint(toPdf, x, y));
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const rect: UserRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (item.kind === "note") {
        list.push({ kind: "note", rect, text: item.text, color: [item.color.r, item.color.g, item.color.b] });
      } else if (item.link?.pageId) {
        const target = indexOfPage.get(item.link.pageId);
        if (target === undefined) droppedLinks++;
        else list.push({ kind: "link", rect, pageIndex: target });
      } else if (item.link?.url) {
        list.push({ kind: "link", rect, url: item.link.url });
      } else {
        droppedLinks++;
      }
    }
    addPageAnnotations(doc, pages[i], list, pages);
  }

  if (input.stripMetadata) {
    stripMetadata(doc);
  } else {
    const now = new Date();
    doc.setProducer("ytaPDF");
    doc.setModificationDate(now);
    if (!inPlace) {
      doc.setCreator("ytaPDF");
      doc.setCreationDate(now);
      if (!doc.getTitle()) doc.setTitle(input.title);
    }
    if (input.metadata) applyMetadata(doc, input.metadata);
  }

  if (!inPlace && input.outline && input.outline.length > 0) writeOutline(doc, pages, input.outline);

  const compression = input.compression
    ? await compressImages(doc, pages, fonts, input.compression, input.recodeImage ?? browserRecoder)
    : undefined;

  // Replaced content, removed annotations and dropped images must not stay in
  // the file as unused objects.
  removeUnreachableObjects(doc);

  if (identity && pages.length > 0) {
    addSignaturePlaceholder(
      doc,
      pages[0],
      { reason: input.signature?.reason?.trim() || undefined, location: input.signature?.location?.trim() || undefined },
      describeCertificate(identity.certificate).name,
    );
  }

  if (input.password) protectDocument(doc, input.password);

  // A signed file is saved without object streams: the signature is written
  // into the saved bytes, which must hold it uncompressed.
  const saved = await doc.save({ useObjectStreams: !identity });
  const bytes = identity ? signSavedPdf(saved, identity) : saved;
  const warnings = exportWarnings(context, failedFields, rasters.size, failedText.length);
  if (droppedLinks > 0) {
    warnings.push(
      droppedLinks === 1
        ? t("Un enlace no tenía destino (o su página ya no está) y no se incluyó.")
        : t("{n} enlaces no tenían destino (o su página ya no está) y no se incluyeron.", { n: droppedLinks }),
    );
  }
  if (substituted.size > 0) {
    warnings.unshift(
      t("Algunos caracteres no existen en la fuente original del documento y se dibujaron con una fuente parecida: {chars}", {
        chars: [...substituted].slice(0, 12).join(" "),
      }),
    );
  }
  return { bytes, warnings, compression };
}

/**
 * Wraps a page's content in q … Q, so what is drawn after it starts from the
 * page's own coordinates even if the content leaves its transform changed.
 */
const isolated = new WeakSet<PDFPage>();
function isolateContent(page: PDFPage): void {
  if (isolated.has(page)) return;
  isolated.add(page);
  const { context } = page.doc;
  page.node.normalize();
  page.node.wrapContentStreams(context.register(context.stream("q")), context.register(context.stream("Q")));
  // pdf-lib's drawing stream, if it had one, is now inside the wrapper.
  const drawing = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  drawing.contentStream = undefined;
  drawing.contentStreamRef = undefined;
}

/** What the exported file could not keep exactly as the editor showed it. */
function exportWarnings(context: DrawContext, failedFields: string[], rasterCount: number, failedText: number): string[] {
  const warnings: string[] = [];
  if (failedText > 0) {
    warnings.push(
      failedText === 1
        ? t("Un texto editado del documento no se pudo aplicar y se dejó como estaba.")
        : t("{n} textos editados del documento no se pudieron aplicar y se dejaron como estaban.", { n: failedText }),
    );
  }
  if (context.unsupportedChars.size > 0) {
    const chars = [...context.unsupportedChars].slice(0, 12).join(" ");
    warnings.push(
      t(
        "Algunos caracteres no existen en las fuentes estándar del PDF y se sustituyeron por «?»: {chars}. Usa Noto Sans o Noto Serif para conservarlos.",
        { chars },
      ),
    );
  }
  if (context.missingGlyphs.size > 0) {
    const chars = [...context.missingGlyphs].slice(0, 12).join(" ");
    warnings.push(t("La fuente elegida no tiene algunos caracteres y se sustituyeron por «?»: {chars}", { chars }));
  }
  if (context.failedImages.size > 0) {
    warnings.push(
      context.failedImages.size === 1
        ? t("Una imagen no se pudo incluir en el PDF.")
        : t("{n} imágenes no se pudieron incluir en el PDF.", { n: context.failedImages.size }),
    );
  }
  if (failedFields.length > 0) {
    warnings.push(t("No se pudieron rellenar algunos campos del formulario: {fields}.", { fields: failedFields.slice(0, 5).join(", ") }));
  }
  if (rasterCount > 0) {
    warnings.push(
      rasterCount === 1
        ? t("La página con zonas censuradas se exportó como imagen porque había una imagen o un campo de formulario bajo la censura.")
        : t("Las {n} páginas con zonas censuradas se exportaron como imagen porque había imágenes o campos de formulario bajo la censura.", {
            n: rasterCount,
          }),
    );
  }
  return warnings;
}
