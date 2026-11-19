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
import { fabricToDrawables, hasRedactions, redactionAreas, sceneAnnotations, type SceneAnnotation } from "./fabricDrawables";
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

  const job = new ExportJob(input, forcedRaster);
  await job.planRedactions();
  await job.rasterize();
  const { doc, pages } = await job.assemble();

  // Document text first: it rewrites the page content, which the flattened
  // fields and the annotations are then drawn on top of.
  await job.applyEditedText();
  if (input.flattenForms) flattenForm(doc);

  // Redaction comes after the edited text and the flattened fields, so both
  // are cut as well. Pages where it cannot be done exactly start again as images.
  const unredactable = await job.redact();
  if (unredactable.length > 0) return exportDocument(input, new Set([...job.rasterIds, ...unredactable]));

  await job.drawAnnotations();
  await job.addRecognisedText();
  await job.addNotesAndLinks();
  job.writeProperties();

  const compression = input.compression
    ? await compressImages(doc, pages, job.fonts, input.compression, input.recodeImage ?? browserRecoder)
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
  return { bytes, warnings: job.warnings(), compression };
}

/** Raster pages have their own space: the editor's scene, upside down. */
const rasterSpace = (page: PageRef): Matrix => [1, 0, 0, -1, 0, page.height];

/** One export: the document being built and what each step has found. */
class ExportJob {
  /** Redaction boxes of each page, in scene space. */
  readonly redactions = new Map<string, Point[][]>();
  readonly rasterIds: Set<string>;
  /** Pages exported as an image (JPEG bytes). */
  readonly rasters = new Map<string, Uint8Array>();
  readonly failedText: string[] = [];
  readonly substituted = new Set<string>();
  droppedLinks = 0;

  doc!: PDFDocument;
  pages!: PDFPage[];
  inPlace = false;
  failedFields: string[] = [];
  context!: DrawContext;
  fonts!: FontCache;

  constructor(
    readonly input: ExportInput,
    forcedRaster: ReadonlySet<string>,
  ) {
    this.rasterIds = new Set(forcedRaster);
  }

  sourceOf(page: PageRef): SourceDocument {
    const source = this.input.sources.get(page.sourceId);
    if (!source) throw new Error("Falta el documento de origen.");
    return source;
  }

  /** The PDF.js viewport transform of a page as the editor shows it (user space → scene). */
  async viewport(page: PageRef): Promise<Matrix> {
    const pdfjsPage = await this.sourceOf(page).pdf.getPage(page.sourceIndex + 1);
    return viewportOf(pdfjsPage, 1, page).transform as Matrix;
  }

  /** Scene → the exported page's user space. */
  async sceneToPage(page: PageRef): Promise<Matrix> {
    return this.rasters.has(page.id) ? rasterSpace(page) : sceneToPdf(await this.viewport(page));
  }

  /** The pages with their annotations, in output order. */
  *annotatedPages(): Generator<{ page: PageRef; index: number; data: PageAnnotations }> {
    for (let index = 0; index < this.input.pages.length; index++) {
      const page = this.input.pages[index];
      const data = this.input.annotations[page.id];
      if (data && data.objects.length > 0) yield { page, index, data };
    }
  }

  /**
   * What lies under redaction boxes is removed from the page's content.
   * Boxes over objects that show something of their own force an image.
   */
  async planRedactions(): Promise<void> {
    for (const { page, data } of this.annotatedPages()) {
      if (!hasRedactions(data)) continue;
      const { areas, coversContent } = await redactionAreas(data);
      this.redactions.set(page.id, areas);
      if (coversContent) this.rasterIds.add(page.id);
    }
  }

  async rasterize(): Promise<void> {
    for (const page of this.input.pages) {
      if (!this.rasterIds.has(page.id)) continue;
      const options = { dpi: RASTER_DPI, format: "image/jpeg" as const };
      const data = this.input.annotations[page.id];
      this.rasters.set(page.id, await rasterizePage(page, this.sourceOf(page), data, this.input.formValues, options));
    }
  }

  async assemble(): Promise<{ doc: PDFDocument; pages: PDFPage[] }> {
    const placements: PagePlacement[] = this.input.pages.map((page) =>
      this.rasters.has(page.id)
        ? { kind: "raster", width: page.width, height: page.height }
        : { sourceId: page.sourceId, sourceIndex: page.sourceIndex, rotation: page.rotation, crop: page.crop },
    );
    const fieldFont = async (doc: PDFDocument) => {
      doc.registerFontkit((await loadFontkit()) as never);
      return doc.embedFont(await embeddedFontBytes("noto-sans", "regular"), { subset: true });
    };
    const assembled = await assembleDocument(placements, this.input.sources, {
      formValues: this.input.formValues,
      fieldFont,
    });
    this.doc = assembled.doc;
    this.pages = assembled.pages;
    this.inPlace = assembled.inPlace;
    this.failedFields = assembled.failedFields;
    this.context = new DrawContext(this.doc, {
      loadImage,
      loadFont: embeddedFontBytes,
      loadScriptFont: scriptFontBytes,
      fontkit: await loadFontkit(),
    });
    this.fonts = new FontCache(this.doc.context);
    return { doc: this.doc, pages: this.pages };
  }

  /** Rewrites the document text the user edited. */
  async applyEditedText(): Promise<void> {
    for (const { page, index, data } of this.annotatedPages()) {
      if (this.rasters.has(page.id)) continue;
      const specs = await pageSpecs(this.sourceOf(page), page, data);
      if (specs.length === 0) continue;
      const report = await applyNativeSpecs(this.pages[index], specs, this.fonts, fallbackResources(this.context));
      this.failedText.push(...report.failed);
      for (const run of specs.flatMap((spec) => spec.runs)) {
        if (run.font.kind !== "fallback" || !run.font.substitute) continue;
        for (const glyph of run.glyphs) this.substituted.add(glyph.text);
      }
    }
  }

  /** Cuts what lies under the redaction boxes. Returns the pages where that was not possible. */
  async redact(): Promise<string[]> {
    const unredactable: string[] = [];
    for (let i = 0; i < this.input.pages.length; i++) {
      const page = this.input.pages[i];
      const areas = this.redactions.get(page.id);
      if (!areas || this.rasterIds.has(page.id)) continue;
      const toPdf = await this.sceneToPage(page);
      const userAreas = areas.map((area) => area.map(([x, y]) => applyToPoint(toPdf, x, y)));
      const outcome = await redactPage(this.pages[i], userAreas, this.fonts, fallbackResources(this.context));
      if (!outcome.done) unredactable.push(page.id);
    }
    return unredactable;
  }

  /** Raster pages get their image; the others, the user's annotations as vector content. */
  async drawAnnotations(): Promise<void> {
    for (let i = 0; i < this.input.pages.length; i++) {
      const page = this.input.pages[i];
      const raster = this.rasters.get(page.id);
      if (raster) {
        const image = await this.doc.embedJpg(raster);
        this.pages[i].drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
      }
    }
    for (const { page, index, data } of this.annotatedPages()) {
      if (this.rasters.has(page.id)) continue;
      await ensureFontsFor(data.objects);
      const drawables = await fabricToDrawables(data);
      if (drawables.length === 0) continue;
      isolateContent(this.pages[index]);
      await drawOnPage(this.pages[index], drawables, await this.viewport(page), this.context);
    }
  }

  /** Recognised text of scanned pages, invisible over the picture of each word. */
  async addRecognisedText(): Promise<void> {
    let font: Awaited<ReturnType<DrawContext["font"]>> | null = null;
    for (let i = 0; i < this.input.pages.length; i++) {
      const page = this.input.pages[i];
      const recognised = this.input.ocr?.[ocrKey(page.sourceId, page.sourceIndex)];
      if (!recognised || recognised.lines.length === 0) continue;
      const words = await this.#visibleWords(page, recognised);
      if (words.length === 0) continue;
      font ??= await this.context.font({ kind: "embedded", family: "noto-sans", variant: "regular" });
      isolateContent(this.pages[i]);
      addInvisibleText(this.pages[i], words, font.font, font.canEncode);
    }
  }

  /** Recognised words that no redaction box covers, placed in the exported page's space. */
  async #visibleWords(page: PageRef, recognised: OcrPage): Promise<{ text: string; quad: Point[] }[]> {
    const viewport = await this.viewport(page);
    const toPage: Matrix = this.rasters.has(page.id) ? multiply(rasterSpace(page), viewport) : IDENTITY;
    const hidden = this.redactions.get(page.id) ?? [];
    return recognised.lines
      .flatMap((line) => line.words)
      .filter((word) => !hidden.some((area) => overlapArea(toSceneQuad(word.quad, viewport), area) > 0))
      .map((word) => ({ text: word.text, quad: word.quad.map(([x, y]) => applyToPoint(toPage, x, y)) }));
  }

  /** Notes and links, as annotations other readers can open and follow. */
  async addNotesAndLinks(): Promise<void> {
    const indexOfPage = new Map(this.input.pages.map((page, i) => [page.id, i]));
    for (const { page, index, data } of this.annotatedPages()) {
      const found = await sceneAnnotations(data);
      if (found.length === 0) continue;
      const toPdf = await this.sceneToPage(page);
      const hidden = this.redactions.get(page.id) ?? [];
      const list: PageAnnotation[] = [];
      for (const item of found) {
        // Whatever a redaction box covers is gone, notes and links included.
        if (hidden.some((area) => overlapArea(item.corners, area) > 0.5)) continue;
        const annotation = annotationFor(item, boundingRect(item.corners, toPdf), indexOfPage);
        if (annotation) list.push(annotation);
        else this.droppedLinks++;
      }
      addPageAnnotations(this.doc, this.pages[index], list, this.pages);
    }
  }

  writeProperties(): void {
    const { doc, input } = this;
    if (input.stripMetadata) {
      stripMetadata(doc);
    } else {
      const now = new Date();
      doc.setProducer("ytaPDF");
      doc.setModificationDate(now);
      if (!this.inPlace) {
        doc.setCreator("ytaPDF");
        doc.setCreationDate(now);
        if (!doc.getTitle()) doc.setTitle(input.title);
      }
      if (input.metadata) applyMetadata(doc, input.metadata);
    }
    if (!this.inPlace && input.outline && input.outline.length > 0) writeOutline(doc, this.pages, input.outline);
  }

  warnings(): string[] {
    const warnings = exportWarnings(this.context, this.failedFields, this.rasters.size, this.failedText.length);
    if (this.droppedLinks > 0) {
      warnings.push(
        this.droppedLinks === 1
          ? t("Un enlace no tenía destino (o su página ya no está) y no se incluyó.")
          : t("{n} enlaces no tenían destino (o su página ya no está) y no se incluyeron.", { n: this.droppedLinks }),
      );
    }
    if (this.substituted.size > 0) {
      warnings.unshift(
        t("Algunos caracteres no existen en la fuente original del documento y se dibujaron con una fuente parecida: {chars}", {
          chars: [...this.substituted].slice(0, 12).join(" "),
        }),
      );
    }
    return warnings;
  }
}

/** The box (user space) around corners given in scene space. */
function boundingRect(corners: Point[], toPdf: Matrix): UserRect {
  const points = corners.map(([x, y]) => applyToPoint(toPdf, x, y));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The PDF annotation for a note or a link, or null for a link that goes nowhere. */
function annotationFor(item: SceneAnnotation, rect: UserRect, indexOfPage: Map<string, number>): PageAnnotation | null {
  if (item.kind === "note") {
    return { kind: "note", rect, text: item.text, color: [item.color.r, item.color.g, item.color.b] };
  }
  if (item.link?.pageId) {
    const target = indexOfPage.get(item.link.pageId);
    return target === undefined ? null : { kind: "link", rect, pageIndex: target };
  }
  return item.link?.url ? { kind: "link", rect, url: item.link.url } : null;
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
