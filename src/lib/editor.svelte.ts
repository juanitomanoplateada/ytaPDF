import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { tick } from "svelte";
import { normalizeRotation, rotateAnnotations, type QuarterTurn } from "./annotationTransforms";
import type { AlignMode } from "./arrange";
import { cropShift, intersectBox, sceneRectToBox } from "./crop";
import { decorationObjects, hasDecorations, measureText, type PageDecorations } from "./decorations";
import {
  canPickSaveLocation,
  downloadBytes,
  ensureWritable,
  MIME,
  pickSaveLocation,
  printPdf,
  releasePrintFrame,
  shareFile,
  writeToHandle,
  type SaveHandle,
} from "./deliver";
import type { DocumentMetadata, ExportResult, SignatureRequest } from "./export";
import type { CertificateProblem, CertificateSummary } from "./export/sign";
import type { RasterFormat } from "./export/raster";
import { DEFAULT_FONT_FAMILY } from "./fonts";
import { formatBytes, formatDate, pagesLabel, t } from "./i18n.svelte";
import { COMPRESSION_PRESETS, type CompressionLevel } from "./compression";
import { getImageAsset, importImage, readImageAsset, registerImage, releaseImageAssets, type ImageAsset } from "./images";
import { notifications } from "./notifications.svelte";
import { makeBlankPdf } from "./blankPdf";
import { readOutline, tieOutline, toOutlineEntries, type Bookmark, type SourceOutlineItem } from "./outline";
import { describePages, sanitizeFileName } from "./pageRanges";
import { createZip, type ZipEntry } from "./zip";
import { openPdf, pageTextContent, PasswordCancelledError, syncFormStorage, viewportOf, type Box, type FormValue } from "./pdfjs";
import {
  clearRecoveryCopies,
  deleteSession,
  listSessions,
  loadSession,
  recoveryEnabled,
  saveSession,
  setRecoveryEnabled,
  type SavedSession,
  type SessionSummary,
} from "./session";
import type { TextMarkKind } from "./textMarks";
import { clearThumbnailCache } from "./thumbnails";
import { textEditing } from "./pdfText/service";
import type { PageTextAnalysis } from "./pdfText/types";
import type { Matrix } from "./geometry";
import { ocrKey, withOcrText, type OcrPage } from "./ocrText";
import type { OcrLanguage } from "./ocr";

function certificateMessage(problem: CertificateProblem): string {
  switch (problem) {
    case "password":
      return t("La contraseña del certificado no es correcta.");
    case "no-key":
      return t("El archivo no incluye la clave privada del certificado: expórtalo de nuevo con ella.");
    case "unsupported-key":
      return t("Este certificado usa claves de curva elíptica, que todavía no se admiten. Usa un certificado con clave RSA.");
    default:
      return t("El archivo no es un certificado PKCS#12 (.p12 o .pfx) válido.");
  }
}

/**
 * What Save as reports: some pages exported (`target` is how many), the whole
 * document saved into a file (its name) or downloaded (null).
 */
function saveMessage(protectedFile: boolean, target: number | string | null): string {
  if (typeof target === "number") {
    return protectedFile
      ? t("Se exportaron {pages} con contraseña.", { pages: pagesLabel(target) })
      : t("Se exportaron {pages}.", { pages: pagesLabel(target) });
  }
  if (target !== null) {
    return protectedFile ? t("Se guardó «{name}» con contraseña.", { name: target }) : t("Se guardó «{name}».", { name: target });
  }
  return protectedFile ? t("PDF exportado con contraseña.") : t("PDF exportado correctamente.");
}

/** Annotations moved by (dx, dy), as when the crop box moves the page's origin. */
function shiftAnnotations(data: PageAnnotations, dx: number, dy: number): PageAnnotations {
  return {
    ...data,
    objects: data.objects.map((object) => ({
      ...object,
      left: Number(object.left ?? 0) + dx,
      top: Number(object.top ?? 0) + dy,
    })),
  };
}

/**
 * The crop box for a scene rectangle of a page as shown now, or null when it
 * is too small or misses what the page shows.
 */
function cropFor(
  page: PageRef,
  view: Box,
  transform: number[],
  rect: { x0: number; y0: number; x1: number; y1: number },
): Box | null {
  if (rect.x1 - rect.x0 < MIN_CROP || rect.y1 - rect.y0 < MIN_CROP) return null;
  const visible = (page.crop ?? view).slice() as Box;
  return intersectBox(sceneRectToBox(transform as Box & number[], rect), visible) ?? null;
}

export interface OcrOptions {
  /** Skips pages that already have text of their own. */
  onlyWithoutText?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { page: number; total: number; fraction: number; loading: boolean }) => void;
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const abort = () => reject(new DOMException("Detenido", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  ]);
}

/** Whether a page has text of its own (it is not just a scanned image). */
async function hasOwnText(proxy: PDFPageProxy): Promise<boolean> {
  try {
    const content = await pageTextContent(proxy);
    let chars = 0;
    for (const item of content.items) if ("str" in item) chars += item.str.replaceAll(/\s+/g, "").length;
    return chars >= 20;
  } catch {
    return false;
  }
}

/** A PDF file the user opened. Its bytes stay untouched until export. */
export interface SourceDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** Password the user typed to open it, kept in memory only. */
  password?: string;
  pdf: PDFDocumentProxy;
  pageCount: number;
  /** Made by the app (blank pages): it has no bookmarks of its own. */
  generated?: boolean;
}

/**
 * One page of the document being edited. Pages point into a source document,
 * so reordering, deleting, rotating, cropping or merging never rewrites PDF
 * bytes until export.
 */
export interface PageRef {
  id: string;
  sourceId: string;
  /** Zero-based page index inside the source document. */
  sourceIndex: number;
  /** Clockwise rotation added by the user on top of the page's own. */
  rotation: number;
  /** Area kept by the user's crop, in PDF user space (none: the page's own crop box). */
  crop?: Box;
  /** Size of the PDF.js viewport at scale 1 (rotations and crop applied). */
  width: number;
  height: number;
}

/**
 * Fabric canvas JSON for one page. Coordinates are in scene units: the PDF.js
 * viewport at scale 1, so they do not depend on the zoom level.
 */
export interface PageAnnotations {
  version?: string;
  objects: Record<string, unknown>[];
}

export type DrawTool = "rect" | "ellipse" | "line" | "arrow" | "highlight" | "redact" | "note" | "link";

/** Where a link goes: a web address (or e-mail) or a page of the document. */
export interface LinkTarget {
  url?: string;
  pageId?: string;
}
/**
 * `pen` draws freehand strokes; `textselect` selects the document's text to
 * copy or mark it; `crop` draws the area of the page to keep.
 */
export type Tool = "select" | "text" | "edit" | "pen" | "textselect" | "crop" | DrawTool;
/** `ink` is a freehand stroke; `mark` a check mark or a cross. */
export type ObjectKind = "text" | "image" | "signature" | "ink" | "mark" | "group" | DrawTool;
export type ArrangeAction = "front" | "forward" | "backward" | "back";
export type TextAlign = "left" | "center" | "right";
export type MarkKind = "check" | "cross";

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  underline: boolean;
  linethrough: boolean;
  textAlign: TextAlign;
  /** Distance between lines, as a multiple of the font size. */
  lineHeight: number;
}

export interface ShapeStyle {
  stroke: string;
  /** `null` leaves the shape transparent. */
  fill: string | null;
  strokeWidth: number;
}

/**
 * A drawn or typed signature: an SVG path whose bounding box starts at the
 * origin. Drawn ones are stroked; typed ones are glyph outlines, filled.
 */
export interface SignatureData {
  path: string;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  filled?: boolean;
  /** Initials are inserted smaller than a full signature. */
  initials?: boolean;
}

/** A signature taken from a photo: ink on a transparent background (PNG data URL). */
export interface SignatureImage {
  image: string;
  width: number;
  height: number;
  initials?: boolean;
}

export type SignatureContent = SignatureData | SignatureImage;

export function isSignatureImage(content: SignatureContent): content is SignatureImage {
  return typeof (content as SignatureImage).image === "string";
}

/** An area in scene units. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionInfo {
  kind: ObjectKind | "multiple";
  count: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  /** Style of the selected text, or of the first text in a multiple selection. */
  text: TextStyle | null;
  /** The selection includes text of the document itself. */
  native: boolean;
  /** Fonts of the document that selected document text can go back to. */
  originalFonts: { label: string; css: string }[];
  /** Characters of selected document text that its original font lacks. */
  substituted: string[];
  /** Style of the first shape, line or signature in the selection. */
  shape: ShapeStyle | null;
  /** Colour of the first highlight in the selection. */
  highlight: string | null;
  locked: boolean;
  canRaise: boolean;
  canLower: boolean;
  /** Box around the selection on the page, rotation included (scene units). */
  bounds: { left: number; top: number; width: number; height: number };
  /** Size of a single object before its rotation (null for several). */
  size: { width: number; height: number } | null;
  /** Several objects that can become a group (no document text among them). */
  canGroup: boolean;
  /** Target of the selected link. */
  link: LinkTarget | null;
}

export interface CopiedObjects {
  objects: Record<string, unknown>[];
  text: string;
}

/** Changes to the position or size of the selection, in scene units. */
export interface BoundsChange {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** Operations a mounted page exposes to the toolbar and keyboard shortcuts. */
export interface PageController {
  /** `width` is in scene units; by default the image fits in 60 % of the page. */
  addImage(url: string, options?: { width?: number }): Promise<void>;
  addSignature(signature: SignatureData): void;
  addMark(kind: MarkKind): void;
  addText(content: string, style?: Partial<TextStyle>): void;
  /** Marks the part of `range` that falls on this page's text. Returns how many lines it marked. */
  markText(range: Range, kind: TextMarkKind): number;
  applyTextStyle(style: Partial<TextStyle>): void;
  applyShapeStyle(style: Partial<ShapeStyle>, highlight?: string): void;
  rotateSelection(degrees: number): void;
  flipSelection(axis: "x" | "y"): void;
  setSelectionOpacity(opacity: number): void;
  arrangeSelection(action: ArrangeAction): void;
  alignSelection(mode: AlignMode): void;
  distributeSelection(axis: "horizontal" | "vertical"): void;
  groupSelection(): void;
  ungroupSelection(): void;
  setSelectionBounds(change: BoundsChange, keepRatio: boolean): void;
  toggleLockSelection(): void;
  deleteSelection(): { removed: number; locked: number };
  duplicateSelection(): Promise<void>;
  copySelection(): CopiedObjects | null;
  pasteObjects(objects: Record<string, unknown>[], offset: number): Promise<void>;
  nudgeSelection(dx: number, dy: number): void;
  clearSelection(): void;
  isEditingText(): boolean;
  /** Removes the selected edits of document text, bringing the original back. */
  restoreOriginalText(): void;
  setLinkTarget(target: LinkTarget): void;
}

export interface PasswordRequest {
  fileName: string;
  incorrect: boolean;
  resolve: (password: string | null) => void;
}

/** Values typed into a document's own form fields, by source and field name. */
export type FormValues = Record<string, Record<string, FormValue>>;

interface Snapshot {
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  formValues: FormValues;
  decorations: PageDecorations | null;
}

interface ViewportHooks {
  scrollToPage(pageId: string, smooth: boolean): void;
  fitWidth(): number | null;
  /** Zoom at which the whole page fits in the window. */
  fitPage(pageId: string): number | null;
}

/** Options of an exported PDF that are chosen for each export. */
export interface PdfOptions {
  password?: string;
  flattenForms?: boolean;
  /** Recompresses the JPEG images to make the file smaller. */
  compression?: CompressionLevel;
  /** Signs the file with a certificate (PKCS#12). Not compatible with `password`. */
  signature?: SignatureRequest;
}

/** Where Save writes, when the browser gave the app a file it may overwrite. */
interface SaveTarget extends PdfOptions {
  handle: SaveHandle;
  /** The user already agreed to replace this file (or chose it to save into). */
  confirmed: boolean;
}

export interface OverwriteRequest {
  fileName: string;
  resolve: (confirmed: boolean) => void;
}

const EMPTY_METADATA: DocumentMetadata = { title: "", author: "", subject: "", keywords: "" };

/** Width at which a signature (or initials) is inserted on a page this wide. */
export function signatureWidth(pageWidth: number): number {
  return Math.min(220, pageWidth * 0.4);
}

/** Initials are placed smaller than a full signature. */
export function initialsWidth(pageWidth: number): number {
  return Math.min(90, pageWidth * 0.18);
}

/** Width to place a saved signature or initials at on a page of `pageWidth`. */
export function placedSignatureWidth(pageWidth: number, signature: { initials?: boolean }): number {
  return signature.initials ? initialsWidth(pageWidth) : signatureWidth(pageWidth);
}

const HISTORY_LIMIT = 100;
/** Edits sharing a key within this window become a single undo step. */
const COALESCE_WINDOW_MS = 1200;
const AUTOSAVE_DELAY_MS = 1500;
/** How far each paste on the same page is shifted, in scene units. */
const PASTE_OFFSET = 14;
/** Smallest side of a cropped page, in points. */
const MIN_CROP = 12;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT_FAMILY.css,
  fontSize: 24,
  fill: "#000000",
  fontWeight: "normal",
  fontStyle: "normal",
  underline: false,
  linethrough: false,
  textAlign: "left",
  lineHeight: 1.16,
};

export const DEFAULT_SHAPE_STYLE: ShapeStyle = { stroke: "#d32f2f", fill: null, strokeWidth: 3 };
export const DEFAULT_HIGHLIGHT = "#ffe14d";

let idCounter = 0;
function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function baseName(fileName: string): string {
  return fileName.replace(/\.(pdf|ytapdf|png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif)$/i, "").trim() || t("documento");
}

class Editor {
  /** Opened files, indexed by id. Not reactive: pages reference them by id. */
  readonly sources = new Map<string, SourceDocument>();

  pages = $state.raw<PageRef[]>([]);
  annotations = $state.raw<Record<string, PageAnnotations>>({});
  formValues = $state.raw<FormValues>({});
  /** Page numbers, header, footer and watermark (null: none). */
  decorations = $state.raw<PageDecorations | null>(null);
  /** Bumped per source when its form values reach PDF.js, to repaint pages. */
  formRevision = $state.raw<Record<string, number>>({});
  documentName = $state("");
  currentPageId = $state<string | null>(null);
  zoom = $state(1);
  tool = $state<Tool>("select");
  view = $state<"editor" | "organizer">("editor");
  sidebarOpen = $state(false);
  sidebarTab = $state<"pages" | "bookmarks">("pages");
  selection = $state<SelectionInfo | null>(null);
  /** Text of the document selected with the text tool (empty: none). */
  selectedText = $state("");
  /** Area drawn with the crop tool, waiting to be applied. */
  pendingCrop = $state<{ pageId: string; rect: Rect } | null>(null);
  /** Style for new text, mirrored from the last text the user styled. */
  textStyle = $state<TextStyle>({ ...DEFAULT_TEXT_STYLE });
  shapeStyle = $state<ShapeStyle>({ ...DEFAULT_SHAPE_STYLE });
  highlightColor = $state(DEFAULT_HIGHLIGHT);
  busy = $state<string | null>(null);
  /** Text recognised on scanned pages, by source page (see `ocrKey`). */
  ocr = $state.raw<Record<string, OcrPage>>({});
  passwordRequest = $state<PasswordRequest | null>(null);
  overwriteRequest = $state<OverwriteRequest | null>(null);
  signatureOpen = $state(false);
  /** The signature dialog creates initials instead of a full signature. */
  signatureInitials = $state(false);
  exportDialog = $state<"pdf" | "image" | null>(null);
  decorationsOpen = $state(false);
  /** The OCR dialog is open. */
  ocrDialog = $state(false);
  /** The on-device AI dialog (summary, translation) is open. */
  aiDialog = $state(false);
  shortcutsOpen = $state(false);
  /** Properties written on export instead of the document's own (null keeps them). */
  metadata = $state<DocumentMetadata | null>(null);
  stripMetadata = $state(false);
  /** Name chosen for exported files, without extension (null: the default one). */
  customFileName = $state<string | null>(null);
  /** Name of the file Save overwrites, when there is one. */
  saveTargetName = $state<string | null>(null);
  hasClipboard = $state(false);
  recoveryEnabled = $state(recoveryEnabled());
  /** Works kept in this browser, newest first. */
  savedWorks = $state.raw<SessionSummary[]>([]);
  /** The open document was saved in the browser on purpose and is kept there. */
  keptWork = $state(false);
  /** The document's bookmarks, tied to its current pages. */
  bookmarks = $state.raw<Bookmark[]>([]);

  #history = $state.raw<Snapshot[]>([]);
  #historyIndex = $state(0);
  /** History index matching the last export, or -1 if it no longer exists. */
  #savedIndex = $state(0);
  #lastCommit: { key: string | null; at: number } = { key: null, at: 0 };

  readonly #controllers = new Map<string, PageController>();
  #selectionOwner: string | null = null;
  readonly #flushers = new Set<() => void>();
  #viewport: ViewportHooks | null = null;
  /** Copied objects, the page they came from and how many times each page received them. */
  #clipboard: (CopiedObjects & { pageId: string; pastes: Record<string, number> }) | null = null;
  #autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  #autosaveFailed = false;
  #saveTarget: SaveTarget | null = null;
  #workId = createId("trabajo");
  readonly #outlines = new Map<string, Promise<SourceOutlineItem[]>>();
  #bookmarksTask: Promise<void> = Promise.resolve();
  #bookmarksGeneration = 0;

  hasDocument = $derived(this.pages.length > 0);
  /** Exported files are called this (plus the extension). */
  fileName = $derived(this.customFileName ?? `${this.documentName}_ytaPDF`);
  canUndo = $derived(this.#historyIndex > 0);
  canRedo = $derived(this.#historyIndex < this.#history.length - 1);
  isDirty = $derived(this.#historyIndex !== this.#savedIndex);
  currentPageIndex = $derived(
    Math.max(0, this.pages.findIndex((page) => page.id === this.currentPageId)),
  );

  /** The objects that decorate each page (numbers, header, footer, watermark). */
  decorationObjects = $derived.by((): Record<string, Record<string, unknown>[]> => {
    const decorations = this.decorations;
    if (!hasDecorations(decorations)) return {};
    const date = formatDate(new Date(), { day: "2-digit", month: "2-digit", year: "numeric" });
    return Object.fromEntries(
      this.pages.map((page, index) => [
        page.id,
        decorationObjects(decorations, {
          index,
          total: this.pages.length,
          width: page.width,
          height: page.height,
          name: this.documentName,
          date,
          measure: measureText,
        }),
      ]),
    );
  });

  /**
   * What each page shows and exports: its decorations, then its annotations
   * on top (as in the editor, where decorations are painted under them).
   */
  renderedAnnotations = $derived.by((): Record<string, PageAnnotations> => {
    const decorated = this.decorationObjects;
    if (Object.keys(decorated).length === 0) return this.annotations;
    const result: Record<string, PageAnnotations> = { ...this.annotations };
    for (const [pageId, objects] of Object.entries(decorated)) {
      if (objects.length === 0) continue;
      const own = this.annotations[pageId];
      result[pageId] = { version: own?.version, objects: [...objects, ...(own?.objects ?? [])] };
    }
    return result;
  });

  // ── Documents ────────────────────────────────────────────────────────────

  /**
   * Opens PDFs as a new document, or adds them to the open one at
   * `insertAt` (by default, at the end). `handles` are the files the
   * operating system gave the installed app, which Save may overwrite.
   */
  async openFiles(
    files: Iterable<File>,
    options: { insertAt?: number; handles?: (SaveHandle | undefined)[] } = {},
  ): Promise<void> {
    const list = [...files];
    if (list.length === 0 || this.busy) return;

    const added: PageRef[] = [];
    const failures: string[] = [];
    let firstName: string | null = null;
    let opened = 0;

    this.busy = list.length > 1 ? t("Abriendo documentos…") : t("Abriendo documento…");
    try {
      for (const file of list) {
        try {
          const source = await this.#loadSource(file.name, new Uint8Array(await file.arrayBuffer()));
          if (!source) continue;
          firstName ??= source.name;
          opened += 1;
          added.push(...(await this.#createPageRefs(source)));
        } catch (error) {
          console.error(`Error al abrir ${file.name}:`, error);
          failures.push(
            error instanceof UserFacingError
              ? error.message
              : t("No se pudo abrir «{name}». El archivo puede estar dañado.", { name: file.name }),
          );
        }
      }
    } finally {
      this.busy = null;
    }

    for (const message of failures) notifications.error(message);
    if (added.length === 0) return;

    const isNew = !this.hasDocument;
    // Pages were added, so some file opened and gave its name.
    this.#placeNewPages(added, options.insertAt, firstName!);
    // Save can write back to the file only when it is the whole document.
    const handle = options.handles?.[0];
    if (isNew && opened === 1 && list.length === 1 && handle) {
      this.#saveTarget = { handle, confirmed: false };
      this.saveTargetName = handle.name;
    }
  }

  /**
   * Adds pages to the open document at `insertAt` (or the end), or makes
   * them a new document called `name` when none is open.
   */
  #placeNewPages(added: PageRef[], insertAt: number | undefined, name: string): void {
    if (!this.hasDocument) {
      this.#startDocument(baseName(name), { pages: added, annotations: {}, formValues: {}, decorations: null });
      return;
    }
    const at = insertAt === undefined ? this.pages.length : Math.max(0, Math.min(insertAt, this.pages.length));
    const atEnd = at === this.pages.length;
    const pages = [...this.pages];
    pages.splice(at, 0, ...added);
    this.#commit({ pages });
    notifications.success(
      atEnd
        ? t("Se añadieron {pages} al final.", { pages: pagesLabel(added.length) })
        : t("Se insertaron {pages} a partir de la posición {n}.", { pages: pagesLabel(added.length), n: at + 1 }),
      { label: t("Deshacer"), run: () => this.undo() },
    );
  }

  #startDocument(name: string, snapshot: Snapshot, work?: { id: string; kept: boolean }): void {
    this.documentName = name;
    this.#workId = work?.id ?? createId("trabajo");
    this.keptWork = work?.kept ?? false;
    this.#resetHistory(snapshot);
    // Documents start with pages: opened files or a work with some left.
    this.currentPageId = snapshot.pages[0].id;
    this.view = "editor";
  }

  /** Starts an empty document with one page of the given size (A4 by default). */
  async createBlankDocument(width = 595.28, height = 841.89): Promise<void> {
    if (this.busy || this.hasDocument) return;
    const source = await this.#loadSource(t("Documento en blanco"), makeBlankPdf(width, height));
    if (!source) return;
    source.generated = true;
    this.#placeNewPages(await this.#createPageRefs(source), undefined, t("documento"));
  }

  /**
   * Turns images into pages, one per image, sized to their proportions. With
   * no document open they become a new one.
   */
  async addImagePages(files: Iterable<File>, insertAt?: number): Promise<void> {
    const list = [...files];
    if (list.length === 0 || this.busy) return;

    const assets: ImageAsset[] = [];
    const failures: string[] = [];
    let source: SourceDocument | null = null;
    this.busy = list.length > 1 ? t("Convirtiendo imágenes…") : t("Convirtiendo imagen…");
    try {
      for (const file of list) {
        try {
          assets.push(await readImageAsset(file));
        } catch (error) {
          console.error(`Error al leer ${file.name}:`, error);
          failures.push(file.name);
        }
      }
      if (assets.length > 0) {
        const { imagesToPdf } = await import("./imagePdf");
        const name = list.length === 1 ? baseName(list[0].name) : t("imagenes");
        source = await this.#loadSource(`${name}.pdf`, await imagesToPdf(assets, name));
      }
    } catch (error) {
      console.error("Error al convertir las imágenes:", error);
      notifications.error(t("No se pudieron convertir las imágenes en páginas."));
    } finally {
      this.busy = null;
    }

    for (const name of failures) notifications.error(t("No se pudo usar «{name}» como imagen.", { name }));
    if (!source) return;
    this.#placeNewPages(await this.#createPageRefs(source), insertAt, source.name);
  }

  async #loadSource(name: string, bytes: Uint8Array, id = createId("src")): Promise<SourceDocument | null> {
    if (!looksLikePdf(bytes)) {
      throw new UserFacingError(t("«{name}» no es un archivo PDF.", { name }));
    }

    let opened;
    try {
      opened = await openPdf(bytes, (incorrect) => this.#askPassword(name, incorrect));
    } catch (error) {
      if (error instanceof PasswordCancelledError) {
        notifications.info(t("No se abrió «{name}» porque requiere contraseña.", { name }));
        return null;
      }
      throw error;
    }

    const source: SourceDocument = {
      id,
      name,
      bytes,
      password: opened.password,
      pdf: opened.pdf,
      pageCount: opened.pdf.numPages,
    };
    this.sources.set(source.id, source);
    return source;
  }

  async #createPageRefs(source: SourceDocument): Promise<PageRef[]> {
    const indices = Array.from({ length: source.pageCount }, (_, i) => i);
    return Promise.all(
      indices.map(async (index) => {
        const page = await source.pdf.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        return {
          id: createId("page"),
          sourceId: source.id,
          sourceIndex: index,
          rotation: 0,
          width: viewport.width,
          height: viewport.height,
        };
      }),
    );
  }

  #askPassword(fileName: string, incorrect: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      this.passwordRequest = {
        fileName,
        incorrect,
        resolve: (password) => {
          this.passwordRequest = null;
          resolve(password);
        },
      };
    });
  }

  closeDocument(): void {
    this.flushPendingEdits();
    this.clearSelection();
    for (const source of this.sources.values()) void source.pdf.loadingTask.destroy();
    this.sources.clear();
    this.#outlines.clear();
    releaseImageAssets();
    clearThumbnailCache();
    textEditing.reset();
    this.#clipboard = null;
    this.hasClipboard = false;
    if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = null;
    // A recovery copy is only for a tab closed by mistake; kept works stay.
    const closing = this.#workId;
    if (!this.keptWork) void deleteSession(closing).then(() => this.refreshWorks());

    this.#resetHistory({ pages: [], annotations: {}, formValues: {}, decorations: null });
    this.formRevision = {};
    this.documentName = "";
    this.customFileName = null;
    this.metadata = null;
    this.stripMetadata = false;
    this.#saveTarget = null;
    this.saveTargetName = null;
    this.keptWork = false;
    this.#workId = createId("trabajo");
    this.bookmarks = [];
    this.ocr = {};
    this.ocrDialog = false;
    this.aiDialog = false;
    this.selectedText = "";
    this.pendingCrop = null;
    releasePrintFrame();
    this.currentPageId = null;
    this.tool = "select";
    this.view = "editor";
    this.sidebarOpen = false;
    this.zoom = 1;
  }

  // ── Names and properties ─────────────────────────────────────────────────

  renameDocument(name: string): void {
    const clean = sanitizeFileName(name);
    if (!clean) return;
    this.documentName = clean;
    this.#scheduleAutosave();
  }

  /** Name for exported files; the default one follows the document's name. */
  setFileName(name: string): void {
    const clean = sanitizeFileName(name);
    this.customFileName = !clean || clean === `${this.documentName}_ytaPDF` ? null : clean;
  }

  /**
   * The properties the next export writes: the user's, or those of the
   * document (always the document's with `original`).
   */
  async documentMetadata(original = false): Promise<DocumentMetadata> {
    if (this.metadata && !original) return { ...this.metadata };
    const source = this.pages[0] ? this.sources.get(this.pages[0].sourceId) : undefined;
    if (!source) return { ...EMPTY_METADATA };
    try {
      const { info } = await source.pdf.getMetadata();
      const fields = (info ?? {}) as Record<string, unknown>;
      const read = (key: string) => {
        const value = fields[key];
        return typeof value === "string" ? value : "";
      };
      return { title: read("Title"), author: read("Author"), subject: read("Subject"), keywords: read("Keywords") };
    } catch {
      return { ...EMPTY_METADATA };
    }
  }

  /** `metadata` null keeps the document's own properties. */
  setMetadata(metadata: DocumentMetadata | null, strip: boolean): void {
    this.metadata = metadata;
    this.stripMetadata = strip;
  }

  /** Whether any page of the document has form fields. */
  async hasFormFields(): Promise<boolean> {
    for (const sourceId of new Set(this.pages.map((page) => page.sourceId))) {
      try {
        // PDF.js 6 returns a Map; older versions, a plain object.
        const fields: unknown = await this.sources.get(sourceId)?.pdf.getFieldObjects();
        if (fields instanceof Map ? fields.size > 0 : !!fields && Object.keys(fields).length > 0) return true;
      } catch {
        // A document whose fields cannot be read has none to flatten.
      }
    }
    return false;
  }

  /** Page numbers, header, footer and watermark; null removes them. */
  setDecorations(decorations: PageDecorations | null): void {
    this.#commit({ decorations: hasDecorations(decorations) ? decorations : null });
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Save (Ctrl+S): overwrites the file the document came from or was last
   * saved as, when the browser allows it; otherwise downloads a copy.
   */
  async exportPdf(): Promise<void> {
    if (!this.hasDocument) return;
    const target = this.#saveTarget;
    if (target) {
      await this.#saveToTarget(target);
      return;
    }
    const result = await this.#buildPdf(this.pages);
    if (!result) return;
    downloadBytes(result.bytes, `${this.fileName}.pdf`, MIME.pdf);
    this.#markSaved();
    this.#report(result.warnings, t("PDF exportado correctamente."));
  }

  async #saveToTarget(target: SaveTarget): Promise<void> {
    const name = target.handle.name;
    if (!target.confirmed && !(await this.#confirmOverwrite(name))) return;
    if (!(await ensureWritable(target.handle))) {
      notifications.error(
        t("El navegador no dio permiso para guardar en «{name}». Usa «Guardar como» para elegir otro archivo.", { name }),
      );
      return;
    }
    target.confirmed = true;
    const result = await this.#buildPdf(this.pages, target);
    if (!result) return;
    try {
      await writeToHandle(target.handle, result.bytes);
    } catch (error) {
      console.error("Error al guardar:", error);
      notifications.error(t("No se pudo guardar en «{name}». Usa «Guardar como» para elegir otro archivo.", { name }));
      return;
    }
    this.#markSaved();
    this.#report(result.warnings, t("Se guardó «{name}».", { name }));
  }

  #confirmOverwrite(fileName: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.overwriteRequest = {
        fileName,
        resolve: (confirmed) => {
          this.overwriteRequest = null;
          resolve(confirmed);
        },
      };
    });
  }

  /**
   * Save as: asks where to save (where the browser lets it; otherwise the
   * file is downloaded with the chosen name). Saving the whole document
   * makes that file the one Save writes to, with the same options.
   */
  async saveAs(options: PdfOptions & { fileName: string; pageIds?: string[] }): Promise<boolean> {
    const pages = this.#pagesFor(options.pageIds);
    if (pages.length === 0) return false;
    const whole = pages.length === this.pages.length;
    const name = `${sanitizeFileName(options.fileName) || this.fileName}.pdf`;
    if (whole) this.setFileName(options.fileName);

    const picked = await this.#pickSaveLocation(name);
    if (!picked) return false;
    const { handle } = picked;

    const result = await this.#buildPdf(pages, options);
    if (!result || !(await this.#writePdf(result.bytes, handle, name))) return false;

    if (whole) {
      this.#markSaved();
      if (handle) {
        const { password, flattenForms, compression, signature } = options;
        this.#saveTarget = { handle, confirmed: true, password, flattenForms, compression, signature };
        this.saveTargetName = handle.name;
      }
    }
    let message = saveMessage(!!options.password, whole ? (handle?.name ?? null) : pages.length);
    if (options.signature) message += ` ${t("Lleva tu firma digital: cualquier cambio posterior la invalidará.")}`;
    this.#report(result.warnings, message);
    return true;
  }

  /**
   * Asks where to save, where the browser can. Resolves to null when the
   * user cancels, and to no handle when the file is to be downloaded.
   */
  async #pickSaveLocation(name: string): Promise<{ handle: SaveHandle | null } | null> {
    if (!canPickSaveLocation) return { handle: null };
    try {
      const handle = await pickSaveLocation(name, MIME.pdf);
      return handle ? { handle } : null;
    } catch (error) {
      // Picker refused (policy, no user gesture): fall back to a download.
      console.error("No se pudo abrir el selector de archivos:", error);
      return { handle: null };
    }
  }

  /** Writes the file where the user chose, or downloads it. */
  async #writePdf(bytes: Uint8Array, handle: SaveHandle | null, name: string): Promise<boolean> {
    if (!handle) {
      downloadBytes(bytes, name, MIME.pdf);
      return true;
    }
    try {
      await writeToHandle(handle, bytes);
      return true;
    } catch (error) {
      console.error("Error al guardar:", error);
      notifications.error(t("No se pudo guardar «{name}».", { name: handle.name }));
      return false;
    }
  }

  /** Exports only some pages, in the current order, as a separate file. */
  async exportPages(pageIds: string[]): Promise<void> {
    const pages = this.#pagesFor(pageIds);
    if (pages.length === 0) return;
    const result = await this.#buildPdf(pages);
    if (!result) return;
    const suffix = pages.length === 1 ? t("pagina") : t("paginas");
    downloadBytes(result.bytes, `${this.fileName}_${suffix}.pdf`, MIME.pdf);
    this.#report(result.warnings, t("Se exportaron {pages}.", { pages: pagesLabel(pages.length) }));
  }

  /** Prints the document (or some pages) as it would be exported, with the browser's PDF viewer. */
  async printDocument(pageIds?: string[]): Promise<void> {
    const pages = this.#pagesFor(pageIds);
    if (pages.length === 0) return;
    const result = await this.#buildPdf(pages, {}, t("Preparando la impresión…"));
    if (!result) return;
    try {
      await printPdf(result.bytes);
    } catch (error) {
      console.error("Error al imprimir:", error);
      notifications.error(t("No se pudo abrir la impresión. Exporta el PDF e imprímelo desde tu visor."));
    }
  }

  /** Shares the exported PDF through the operating system (mail, messaging…). */
  async shareDocument(options: PdfOptions & { fileName?: string; pageIds?: string[] } = {}): Promise<void> {
    const pages = this.#pagesFor(options.pageIds);
    if (pages.length === 0) return;
    const name = `${sanitizeFileName(options.fileName ?? "") || this.fileName}.pdf`;
    const result = await this.#buildPdf(pages, options);
    if (!result) return;
    const share = async () => {
      try {
        await shareFile(result.bytes, name, MIME.pdf);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          // Generating took too long and the browser no longer counts it as the
          // user's click: one more click shares the file that is ready.
          notifications.info(t("El PDF está listo para compartir."), { label: t("Compartir"), run: () => void share() });
          return;
        }
        console.error("Error al compartir:", error);
        notifications.error(t("No se pudo compartir el archivo."));
      }
    };
    await share();
  }

  /** Exports pages as PNG or JPEG images: one file, or a ZIP with one per page. */
  async exportImages(options: { pageIds: string[]; format: RasterFormat; dpi: number; fileName: string }): Promise<boolean> {
    const pages = this.#pagesFor(options.pageIds);
    if (pages.length === 0 || this.busy) return false;
    this.flushPendingEdits();
    const extension = options.format === "image/png" ? "png" : "jpg";
    const base = sanitizeFileName(options.fileName, extension) || this.fileName;
    const digits = String(this.pages.length).length;
    const annotations = this.renderedAnnotations;

    this.busy = t("Generando imágenes…");
    try {
      const { rasterizePage } = await import("./export/raster");
      const files: ZipEntry[] = [];
      for (const [i, page] of pages.entries()) {
        if (pages.length > 1) this.busy = t("Generando imágenes… ({n} de {total})", { n: i + 1, total: pages.length });
        const source = this.sources.get(page.sourceId);
        if (!source) throw new Error("Falta el documento de origen.");
        const bytes = await rasterizePage(page, source, annotations[page.id], this.formValues, {
          dpi: options.dpi,
          format: options.format,
        });
        const number = String(this.pages.indexOf(page) + 1).padStart(digits, "0");
        files.push({ name: `${base}_${t("pagina")}-${number}.${extension}`, bytes });
      }
      if (files.length === 1) {
        downloadBytes(files[0].bytes, files[0].name, options.format);
        notifications.success(t("Imagen exportada."));
      } else {
        downloadBytes(createZip(files), `${base}_${t("imagenes")}.zip`, MIME.zip);
        notifications.success(t("Se exportaron {n} imágenes en un archivo ZIP.", { n: files.length }));
      }
      return true;
    } catch (error) {
      console.error("Error al exportar imágenes:", error);
      notifications.error(t("No se pudieron generar las imágenes."));
      return false;
    } finally {
      this.busy = null;
    }
  }

  /**
   * Splits the document into several PDFs, one per group of page indices
   * (in the current order). Several files are delivered in a ZIP.
   */
  async splitDocument(groups: number[][], fileName: string): Promise<boolean> {
    const parts = groups.map((group) => group.map((index) => this.pages[index]).filter(Boolean)).filter((g) => g.length > 0);
    if (parts.length === 0 || this.busy) return false;
    this.flushPendingEdits();
    await this.#bookmarksTask;
    const base = sanitizeFileName(fileName) || this.fileName;
    const files: ZipEntry[] = [];
    const warnings = new Set<string>();

    this.busy = t("Dividiendo el documento…");
    try {
      const { exportDocument } = await import("./export");
      for (const [i, pages] of parts.entries()) {
        if (parts.length > 1) this.busy = t("Dividiendo el documento… ({n} de {total})", { n: i + 1, total: parts.length });
        const result = await exportDocument(this.#exportInput(pages));
        for (const warning of result.warnings) warnings.add(warning);
        const indices = pages.map((page) => this.pages.indexOf(page));
        const label = describePages(indices).replaceAll(", ", "_");
        const prefix = pages.length === 1 ? t("pagina") : t("paginas");
        files.push({ name: `${base}_${prefix}_${label}.pdf`, bytes: result.bytes });
      }
    } catch (error) {
      console.error("Error al dividir:", error);
      notifications.error(t("No se pudo dividir el documento."));
      return false;
    } finally {
      this.busy = null;
    }

    if (files.length === 1) downloadBytes(files[0].bytes, files[0].name, MIME.pdf);
    else downloadBytes(createZip(files), `${base}_${t("dividido")}.zip`, MIME.zip);
    this.#report(
      [...warnings],
      files.length === 1
        ? t("PDF exportado correctamente.")
        : t("Se crearon {n} archivos PDF en un ZIP.", { n: files.length }),
    );
    return true;
  }

  #pagesFor(pageIds?: string[]): PageRef[] {
    if (!pageIds) return this.pages;
    const ids = new Set(pageIds);
    return this.pages.filter((page) => ids.has(page.id));
  }

  #exportInput(pages: PageRef[], options: PdfOptions = {}) {
    const index = new Map(pages.map((page, i) => [page.id, i]));
    return {
      pages,
      annotations: this.renderedAnnotations,
      formValues: this.formValues,
      sources: this.sources,
      title: this.documentName,
      password: options.password || undefined,
      flattenForms: options.flattenForms,
      metadata: this.metadata ?? undefined,
      stripMetadata: this.stripMetadata,
      outline: toOutlineEntries(this.bookmarks, (pageId) => index.get(pageId) ?? -1),
      compression: options.compression ? COMPRESSION_PRESETS[options.compression] : undefined,
      ocr: this.ocr,
      signature: options.signature,
    };
  }

  async #buildPdf(pages: PageRef[], options: PdfOptions = {}, label = t("Generando PDF…")): Promise<ExportResult | null> {
    if (this.busy) return null;
    this.flushPendingEdits();
    this.busy = label;
    try {
      await this.#bookmarksTask;
      const { exportDocument } = await import("./export");
      const result = await exportDocument(this.#exportInput(pages, options));
      const report = result.compression;
      if (report && report.images > 0) {
        notifications.info(
          t("Se recomprimieron {n} imágenes: de {before} a {after}.", {
            n: report.images,
            before: formatBytes(report.before),
            after: formatBytes(report.after),
          }),
        );
      } else if (report) {
        notifications.info(t("Las imágenes del documento ya estaban bien comprimidas: no se cambiaron."));
      }
      return result;
    } catch (error) {
      const { CertificateError } = await import("./export");
      if (error instanceof CertificateError) {
        notifications.error(certificateMessage(error.problem));
        return null;
      }
      console.error("Error al exportar:", error);
      notifications.error(
        t("No se pudo generar el PDF. Si el problema continúa, prueba a quitar la última anotación añadida."),
      );
      return null;
    } finally {
      this.busy = null;
    }
  }

  #report(warnings: string[], success: string): void {
    if (warnings.length > 0) {
      for (const warning of warnings) notifications.warning(warning);
    } else {
      notifications.success(success);
    }
  }

  #markSaved(): void {
    this.#savedIndex = this.#historyIndex;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  deletePage(pageId: string): void {
    this.deletePages([pageId]);
  }

  deletePages(pageIds: string[]): void {
    const ids = new Set(pageIds);
    const remaining = this.pages.filter((page) => !ids.has(page.id));
    if (remaining.length === this.pages.length) return;
    if (remaining.length === 0) {
      notifications.info(t("Un documento necesita al menos una página. Para empezar de nuevo, cierra el documento."));
      return;
    }
    const firstIndex = this.pages.findIndex((page) => ids.has(page.id));
    const removed = this.pages.length - remaining.length;

    this.flushPendingEdits();
    const annotations = Object.fromEntries(Object.entries(this.annotations).filter(([id]) => !ids.has(id)));
    this.#commit({ pages: remaining, annotations });

    if (this.currentPageId && ids.has(this.currentPageId)) {
      this.currentPageId = remaining[Math.min(firstIndex, remaining.length - 1)].id;
    }
    notifications.info(
      removed === 1
        ? t("Página {n} eliminada.", { n: firstIndex + 1 })
        : t("Se eliminaron {pages}.", { pages: pagesLabel(removed) }),
      { label: t("Deshacer"), run: () => this.undo() },
    );
  }

  /** Moves a page so it lands at `targetIndex` in the resulting order. */
  movePage(pageId: string, targetIndex: number): void {
    const from = this.pages.findIndex((page) => page.id === pageId);
    const to = Math.max(0, Math.min(targetIndex, this.pages.length - 1));
    if (from === -1 || from === to) return;

    const pages = [...this.pages];
    const [moved] = pages.splice(from, 1);
    pages.splice(to, 0, moved);
    this.#commit({ pages });
  }

  /**
   * Moves several pages together, keeping their order, to the gap before the
   * page now at `insertionIndex` (`pages.length` is the end).
   */
  movePages(pageIds: string[], insertionIndex: number): void {
    const ids = new Set(pageIds);
    const moving = this.pages.filter((page) => ids.has(page.id));
    if (moving.length === 0) return;
    const rest = this.pages.filter((page) => !ids.has(page.id));
    const before = this.pages.slice(0, Math.max(0, insertionIndex)).filter((page) => !ids.has(page.id)).length;
    const pages = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    if (pages.every((page, i) => page === this.pages[i])) return;
    this.#commit({ pages });
  }

  /** Inserts a copy of each page, with its annotations, right after it. */
  duplicatePages(pageIds: string[]): void {
    const ids = new Set(pageIds);
    if (!this.pages.some((page) => ids.has(page.id))) return;
    this.flushPendingEdits();
    const annotations = { ...this.annotations };
    const pages: PageRef[] = [];
    let count = 0;
    for (const page of this.pages) {
      pages.push(page);
      if (!ids.has(page.id)) continue;
      const copy: PageRef = { ...page, id: createId("page") };
      const data = this.annotations[page.id];
      if (data) annotations[copy.id] = structuredClone(data);
      pages.push(copy);
      count += 1;
    }
    this.#commit({ pages, annotations });
    notifications.success(
      count === 1 ? t("Página duplicada.") : t("Se duplicaron {pages}.", { pages: pagesLabel(count) }),
      { label: t("Deshacer"), run: () => this.undo() },
    );
  }

  /**
   * Reverses the order of the given pages among the places they occupy, or
   * of the whole document when fewer than two are given.
   */
  reversePages(pageIds: string[] = []): void {
    const ids = pageIds.length > 1 ? new Set(pageIds) : null;
    const positions = this.pages.flatMap((page, i) => (!ids || ids.has(page.id) ? [i] : []));
    if (positions.length < 2) return;
    const reversed = positions.map((i) => this.pages[i]).reverse();
    const pages = [...this.pages];
    positions.forEach((position, k) => (pages[position] = reversed[k]));
    this.#commit({ pages });
    notifications.info(
      ids ? t("Se invirtió el orden de las páginas seleccionadas.") : t("Se invirtió el orden de las páginas."),
      { label: t("Deshacer"), run: () => this.undo() },
    );
  }

  /** Rotates pages clockwise; their annotations turn with them. */
  rotatePages(pageIds: string[], delta: QuarterTurn): void {
    const ids = new Set(pageIds);
    if (ids.size === 0) return;
    this.flushPendingEdits();
    this.clearSelection();
    const annotations = { ...this.annotations };
    const pages = this.pages.map((page) => {
      if (!ids.has(page.id)) return page;
      const data = annotations[page.id];
      if (data) annotations[page.id] = rotateAnnotations(data, page.width, page.height, delta);
      const swap = delta !== 180;
      return {
        ...page,
        rotation: normalizeRotation(page.rotation + delta),
        width: swap ? page.height : page.width,
        height: swap ? page.width : page.height,
      };
    });
    this.#commit({ pages, annotations });
  }

  /** Inserts a blank page after `afterPageId` (or at the end), sized like it. */
  async insertBlankPage(afterPageId: string | null): Promise<void> {
    const index = afterPageId ? this.pages.findIndex((page) => page.id === afterPageId) : this.pages.length - 1;
    const reference = this.pages[index] ?? this.pages.at(-1);
    const width = reference?.width ?? 595.28;
    const height = reference?.height ?? 841.89;
    const source = await this.#loadSource(t("Página en blanco"), makeBlankPdf(width, height));
    if (!source) return;
    source.generated = true;
    const [page] = await this.#createPageRefs(source);
    const pages = [...this.pages];
    pages.splice(index + 1, 0, page);
    this.#commit({ pages });
    notifications.success(t("Página en blanco insertada en la posición {n}.", { n: index + 2 }), {
      label: t("Deshacer"),
      run: () => this.undo(),
    });
  }

  goToPage(pageId: string, smooth = true): void {
    this.currentPageId = pageId;
    this.#viewport?.scrollToPage(pageId, smooth);
  }

  /** Goes to a page by its number (1-based), clamped to the document. */
  goToPageNumber(number: number): void {
    if (!Number.isFinite(number) || this.pages.length === 0) return;
    const page = this.pages[Math.max(0, Math.min(Math.round(number) - 1, this.pages.length - 1))];
    this.goToPage(page.id, false);
  }

  // ── Crop ─────────────────────────────────────────────────────────────────

  /**
   * Crops with the area drawn on a page: only that page, or every page with
   * the same margins. Annotations stay on the same spot of the content.
   */
  async applyCrop(scope: "page" | "all"): Promise<void> {
    const pending = this.pendingCrop;
    const reference = pending && this.pages.find((page) => page.id === pending.pageId);
    if (!pending || !reference) return;
    const { x, y, width, height } = pending.rect;
    const margins = { left: x, top: y, right: reference.width - x - width, bottom: reference.height - y - height };
    const ids = new Set(scope === "page" ? [reference.id] : this.pages.map((page) => page.id));
    const changed = await this.#recrop(ids, (page) => ({
      x0: margins.left,
      y0: margins.top,
      x1: page.width - margins.right,
      y1: page.height - margins.bottom,
    }));
    this.pendingCrop = null;
    this.tool = "select";
    if (changed > 0) {
      notifications.success(
        changed === 1 ? t("Página recortada.") : t("Se recortaron {pages}.", { pages: pagesLabel(changed) }),
        { label: t("Deshacer"), run: () => this.undo() },
      );
    }
  }

  /** Shows the whole page again. */
  async removeCrop(pageIds: string[]): Promise<void> {
    const ids = new Set(pageIds.filter((id) => this.pages.find((page) => page.id === id)?.crop));
    if (ids.size === 0) return;
    const changed = await this.#recrop(ids, null);
    this.pendingCrop = null;
    if (changed > 0) notifications.info(t("Se quitó el recorte."), { label: t("Deshacer"), run: () => this.undo() });
  }

  /**
   * Gives pages a new crop: the scene rectangle `area` returns (in the page as
   * shown now), or none. Annotations move so they stay on the same content.
   */
  async #recrop(
    ids: Set<string>,
    area: ((page: PageRef) => { x0: number; y0: number; x1: number; y1: number }) | null,
  ): Promise<number> {
    this.flushPendingEdits();
    this.clearSelection();
    const annotations = { ...this.annotations };
    const pages = [...this.pages];
    let changed = 0;
    for (const [i, page] of this.pages.entries()) {
      const source = ids.has(page.id) ? this.sources.get(page.sourceId) : undefined;
      if (!source) continue;
      const proxy = await source.pdf.getPage(page.sourceIndex + 1);
      const before = viewportOf(proxy, 1, page);
      const crop = area ? cropFor(page, proxy.view as Box, before.transform, area(page)) : undefined;
      if (crop === null) continue;
      const after = viewportOf(proxy, 1, { rotation: page.rotation, crop });
      const [dx, dy] = cropShift(before.transform, after.transform);
      pages[i] = { ...page, crop, width: after.width, height: after.height };
      const data = annotations[page.id];
      if (data && (dx !== 0 || dy !== 0)) annotations[page.id] = shiftAnnotations(data, dx, dy);
      changed += 1;
    }
    if (changed > 0) this.#commit({ pages, annotations });
    return changed;
  }

  // ── Annotations ──────────────────────────────────────────────────────────

  /** Stores a page's annotations and returns the value now held in state. */
  setPageAnnotations(
    pageId: string,
    data: PageAnnotations | null,
    coalesceKey?: string,
  ): PageAnnotations | undefined {
    if (!this.pages.some((page) => page.id === pageId)) return undefined;
    const current = this.annotations[pageId];
    if (!current && (!data || data.objects.length === 0)) return undefined;

    const annotations = { ...this.annotations };
    if (data && data.objects.length > 0) {
      annotations[pageId] = data;
    } else {
      delete annotations[pageId];
    }
    this.#commit({ annotations }, coalesceKey);
    return annotations[pageId];
  }

  setFormValue(sourceId: string, fieldName: string, value: FormValue): void {
    const current = this.formValues[sourceId] ?? {};
    if (current[fieldName] === value) return;
    this.#commit(
      { formValues: { ...this.formValues, [sourceId]: { ...current, [fieldName]: value } } },
      `form:${sourceId}:${fieldName}`,
    );
  }

  /** The page the user is looking at receives new content (pastes, images, signatures). */
  #targetController(pageId = this.currentPageId ?? this.#selectionOwner): PageController | undefined {
    return (pageId && this.#controllers.get(pageId)) || this.#controllers.values().next().value;
  }

  async addImage(file: File, pageId = this.currentPageId): Promise<void> {
    const controller = this.#targetController(pageId);
    if (!controller) {
      notifications.error(t("Abre la vista de edición para añadir imágenes."));
      return;
    }
    let url: string;
    try {
      url = await importImage(file);
    } catch (error) {
      console.error("Error al importar la imagen:", error);
      notifications.error(t("No se pudo usar «{name}» como imagen.", { name: file.name }));
      return;
    }
    await controller.addImage(url);
  }

  openSignature(initials = false): void {
    this.signatureInitials = initials;
    this.signatureOpen = true;
  }

  async insertSignature(content: SignatureContent): Promise<void> {
    this.signatureOpen = false;
    const controller = this.#targetController(this.currentPageId);
    if (!controller) {
      notifications.error(t("Abre la vista de edición para añadir la firma."));
      return;
    }
    this.tool = "select";
    if (!isSignatureImage(content)) {
      controller.addSignature(content);
      return;
    }
    try {
      const url = await importImage(await (await fetch(content.image)).blob());
      const page = this.pages.find((p) => p.id === this.currentPageId) ?? this.pages[0];
      await controller.addImage(url, { width: placedSignatureWidth(page?.width ?? 595, content) });
    } catch (error) {
      console.error("Error al insertar la firma:", error);
      notifications.error(t("No se pudo insertar la firma."));
    }
  }

  /** Adds a check mark or a cross to the current page, to tick boxes on forms. */
  addMark(kind: MarkKind): void {
    const controller = this.#targetController(this.currentPageId);
    if (!controller) return;
    this.tool = "select";
    controller.addMark(kind);
  }

  /** Adds today's date as text. */
  addTodayDate(): void {
    const controller = this.#targetController(this.currentPageId);
    if (!controller) return;
    this.tool = "select";
    controller.addText(todayLabel(), { fontSize: Math.min(this.textStyle.fontSize, 14) });
  }

  /**
   * Highlights, underlines or strikes out the document text selected with
   * the text tool, fitted to each line.
   */
  markSelectedText(kind: TextMarkKind): void {
    const selection = globalThis.getSelection?.() ?? null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    let marked = 0;
    for (const controller of this.#controllers.values()) marked += controller.markText(range, kind);
    selection.removeAllRanges();
    this.selectedText = "";
    if (marked === 0) notifications.info(t("Selecciona texto del documento para marcarlo."));
  }

  /**
   * Runs `work` on the text of every page (the document's own text, as the
   * text editing engine reads it) and commits the annotations it returns.
   */
  async #acrossPages(
    message: string,
    work: (
      page: PageRef,
      analysis: PageTextAnalysis,
      viewport: Matrix,
      data: PageAnnotations | undefined,
    ) => Promise<PageAnnotations | null>,
  ): Promise<boolean> {
    if (this.busy || this.pages.length === 0) return false;
    this.flushPendingEdits();
    this.busy = message;
    try {
      const annotations = { ...this.annotations };
      let changed = false;
      for (const page of this.pages) {
        const source = this.sources.get(page.sourceId);
        if (!source) continue;
        const analysis = await textEditing.analyze(source, page.sourceIndex);
        const viewport = viewportOf(await source.pdf.getPage(page.sourceIndex + 1), 1, page).transform as Matrix;
        const data = await work(page, analysis, viewport, annotations[page.id]);
        if (data) {
          annotations[page.id] = data;
          changed = true;
        }
      }
      if (changed) this.#commit({ annotations });
      return changed;
    } finally {
      this.busy = null;
    }
  }

  /**
   * Replaces a text everywhere in the document. The lines that contain it
   * become edited text (as with the Edit text tool), so the export rewrites
   * them with their own font. Undoable as a single step.
   */
  async replaceText(query: string, replacement: string): Promise<number> {
    if (!query.trim()) return 0;
    let replaced = 0;
    let skipped = 0;
    try {
      const { replaceOnPage } = await import("./textReplace");
      await this.#acrossPages(t("Reemplazando texto…"), async (_page, analysis, viewport, data) => {
        const result = await replaceOnPage(analysis, viewport, data, query, replacement);
        replaced += result.replaced;
        skipped += result.skipped;
        return result.data;
      });
    } catch (error) {
      console.error("No se pudo reemplazar el texto:", error);
      notifications.error(t("No se pudo reemplazar el texto."));
      return 0;
    }
    if (replaced === 0 && skipped === 0) {
      notifications.info(t("No se encontró «{text}» en el texto del documento.", { text: query.trim() }));
    } else if (replaced > 0) {
      notifications.success(
        replaced === 1 ? t("Se reemplazó 1 coincidencia.") : t("Se reemplazaron {n} coincidencias.", { n: replaced }),
        { label: t("Deshacer"), run: () => this.undo() },
      );
    }
    if (skipped > 0) {
      notifications.warning(
        t("{n} coincidencias están en texto que no se puede editar (su fuente no indica qué caracteres dibuja).", {
          n: skipped,
        }),
      );
    }
    return replaced;
  }

  /**
   * Covers every match of a text with a redaction box. At export, what lies
   * under the boxes is removed from the file.
   */
  async redactText(query: string): Promise<number> {
    if (!query.trim()) return 0;
    let boxes = 0;
    try {
      const { ocrRedactionBoxes, redactionBoxesFor } = await import("./textReplace");
      await this.#acrossPages(t("Buscando el texto a censurar…"), async (page, analysis, viewport, data) => {
        const found = [
          ...redactionBoxesFor(analysis, viewport, query),
          ...ocrRedactionBoxes(this.ocr[ocrKey(page.sourceId, page.sourceIndex)], viewport, query),
        ];
        if (found.length === 0) return null;
        boxes += found.length;
        return { ...data, objects: [...(data?.objects ?? []), ...found] };
      });
    } catch (error) {
      console.error("No se pudo censurar el texto:", error);
      notifications.error(t("No se pudo censurar el texto."));
      return 0;
    }
    if (boxes === 0) {
      notifications.info(t("No se encontró «{text}» en el texto del documento.", { text: query.trim() }));
    } else {
      notifications.success(
        boxes === 1
          ? t("Se cubrió 1 coincidencia con una zona censurada. Se eliminará del archivo al exportar.")
          : t("Se cubrieron {n} coincidencias con zonas censuradas. Se eliminarán del archivo al exportar.", { n: boxes }),
        { label: t("Deshacer"), run: () => this.undo() },
      );
    }
    return boxes;
  }

  /**
   * Recognises the text of scanned pages (OCR) on this device. The text is
   * kept by source page: it can then be searched, selected, copied and
   * redacted, and the export adds it to the file as invisible text.
   * Returns false when it was stopped or failed.
   */
  async recognizeText(pageIds: string[], languages: OcrLanguage[], options: OcrOptions = {}): Promise<boolean> {
    const targets = await this.#ocrTargets(pageIds, options.onlyWithoutText ?? false);
    if (targets.length === 0) {
      notifications.info(t("Todas las páginas elegidas ya tienen texto. Elige «Todas» para reconocerlas igualmente."));
      return true;
    }
    const tally = { pages: 0, words: 0 };
    try {
      await this.#recognizeTargets(targets, languages, options, tally);
    } catch (error) {
      await this.#ocrStopped(error, tally.pages);
      return false;
    }
    this.#scheduleAutosave();
    if (tally.words === 0) {
      notifications.info(t("No se encontró texto en {pages}.", { pages: pagesLabel(tally.pages) }));
    } else {
      notifications.success(
        t("Se reconoció el texto de {pages}. Ya se puede buscar, seleccionar y copiar, y se guardará en el PDF.", {
          pages: pagesLabel(tally.pages),
        }),
      );
    }
    return true;
  }

  /** Source pages to recognise, once each, optionally only those without text of their own. */
  async #ocrTargets(pageIds: string[], onlyWithoutText: boolean): Promise<{ proxy: PDFPageProxy; key: string }[]> {
    const wanted = new Set(pageIds);
    const targets: { proxy: PDFPageProxy; key: string }[] = [];
    const seen = new Set<string>();
    for (const page of this.pages) {
      const key = ocrKey(page.sourceId, page.sourceIndex);
      const source = this.sources.get(page.sourceId);
      if (!wanted.has(page.id) || seen.has(key) || !source) continue;
      seen.add(key);
      const proxy = await source.pdf.getPage(page.sourceIndex + 1);
      if (onlyWithoutText && (await hasOwnText(proxy))) continue;
      targets.push({ proxy, key });
    }
    return targets;
  }

  async #recognizeTargets(
    targets: { proxy: PDFPageProxy; key: string }[],
    languages: OcrLanguage[],
    { signal, onProgress }: OcrOptions,
    tally: { pages: number; words: number },
  ): Promise<void> {
    const { recognizePage } = await import("./ocr");
    const total = targets.length;
    for (const [i, { proxy, key }] of targets.entries()) {
      if (signal?.aborted) throw new DOMException("Detenido", "AbortError");
      onProgress?.({ page: i + 1, total, fraction: 0, loading: true });
      const recognising = recognizePage(proxy, languages, ({ progress, status }) => {
        const working = status === "recognizing";
        onProgress?.({ page: i + 1, total, fraction: working ? progress : 0, loading: !working });
      });
      const result = await untilAborted(recognising, signal);
      this.ocr = { ...this.ocr, [key]: result };
      tally.pages++;
      tally.words += result.lines.reduce((n, line) => n + line.words.length, 0);
    }
  }

  /** Reports why recognition ended early; what was recognised before is kept. */
  async #ocrStopped(error: unknown, recognised: number): Promise<void> {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error("No se pudo reconocer el texto:", error);
      notifications.error(t("No se pudo reconocer el texto de la página. Comprueba la conexión la primera vez que lo uses."));
      return;
    }
    const { stopOcr } = await import("./ocr");
    await stopOcr();
    if (recognised > 0) this.#scheduleAutosave();
    notifications.info(
      recognised === 0
        ? t("Se detuvo el reconocimiento de texto.")
        : t("Se detuvo el reconocimiento: se reconoció el texto de {pages}.", { pages: pagesLabel(recognised) }),
    );
  }

  /**
   * The document's own text, page after page (text recognised by OCR
   * included), as PDF.js reads it. Pages are separated by a blank line.
   */
  async documentText(pageIds?: string[]): Promise<string> {
    const pages = this.#pagesFor(pageIds);
    const texts: string[] = [];
    for (const page of pages) {
      const source = this.sources.get(page.sourceId);
      if (!source) continue;
      try {
        const content = withOcrText(
          await pageTextContent(await source.pdf.getPage(page.sourceIndex + 1)),
          this.ocr[ocrKey(page.sourceId, page.sourceIndex)],
        );
        let text = "";
        for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
          if (typeof item.str !== "string") continue;
          text += item.str + (item.hasEOL ? "\n" : "");
        }
        if (text.trim()) texts.push(text.trim());
      } catch (error) {
        console.error("No se pudo leer el texto de una página:", error);
      }
    }
    return texts.join("\n\n");
  }

  /** Opens a certificate file to sign with, to show whose it is before exporting. */
  async checkCertificate(
    bytes: Uint8Array,
    password: string,
  ): Promise<{ summary: CertificateSummary } | { error: string }> {
    const { CertificateError, describeCertificate, readPkcs12 } = await import("./export/sign");
    try {
      return { summary: describeCertificate(readPkcs12(bytes, password).certificate) };
    } catch (error) {
      if (error instanceof CertificateError) return { error: certificateMessage(error.problem) };
      console.error("No se pudo leer el certificado:", error);
      return { error: certificateMessage("format") };
    }
  }

  /** Forgets the text recognised on a page, as if OCR had never run on it. */
  forgetRecognisedText(pageId: string): void {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page) return;
    const { [ocrKey(page.sourceId, page.sourceIndex)]: _removed, ...rest } = this.ocr;
    this.ocr = rest;
    this.#scheduleAutosave();
  }

  /**
   * Copies the selected objects to every other page, at the same place
   * relative to the page's size (the same spot when pages are alike).
   */
  applySelectionToAllPages(): void {
    const ownerId = this.#selectionOwner;
    const copied = this.#owner()?.copySelection();
    const origin = this.pages.find((page) => page.id === ownerId);
    if (!ownerId || !copied || copied.objects.length === 0 || !origin) return;
    if (this.pages.length < 2) {
      notifications.info(t("El documento solo tiene una página."));
      return;
    }
    this.flushPendingEdits();
    const annotations = { ...this.annotations };
    for (const page of this.pages) {
      if (page.id === ownerId) continue;
      const sx = page.width / origin.width;
      const sy = page.height / origin.height;
      const objects = copied.objects.map((object) => ({
        ...structuredClone(object),
        left: Number(object.left ?? 0) * sx,
        top: Number(object.top ?? 0) * sy,
      }));
      const current = annotations[page.id];
      annotations[page.id] = { ...current, objects: [...(current?.objects ?? []), ...objects] };
    }
    this.#commit({ annotations });
    const count = this.pages.length - 1;
    notifications.success(
      count === 1 ? t("Se añadió también a la otra página.") : t("Se añadió también a las otras {n} páginas.", { n: count }),
      { label: t("Deshacer"), run: () => this.undo() },
    );
  }

  addTextFromClipboard(content: string): void {
    const text = content.replaceAll(/\r\n?/g, "\n").trim();
    if (text) this.#targetController()?.addText(text);
  }

  // ── Clipboard ────────────────────────────────────────────────────────────

  /** Copies the selection; returns its plain text for the system clipboard. */
  copySelection(): string | null {
    const pageId = this.#selectionOwner;
    const copied = this.#owner()?.copySelection();
    if (!pageId || !copied || copied.objects.length === 0) return null;
    this.#clipboard = { ...copied, pageId, pastes: {} };
    this.hasClipboard = true;
    return copied.text;
  }

  cutSelection(): string | null {
    const text = this.copySelection();
    if (text !== null) this.deleteSelection();
    return text;
  }

  /** Whether `text` came from the last copy in this app (not from elsewhere). */
  isOwnClipboardText(text: string): boolean {
    return this.#clipboard !== null && this.#clipboard.text === text;
  }

  async pasteObjects(): Promise<boolean> {
    const clip = this.#clipboard;
    const pageId = this.currentPageId ?? this.#selectionOwner;
    const controller = pageId ? this.#controllers.get(pageId) : undefined;
    if (!clip || !controller || !pageId) return false;
    // Repeated pastes on a page (or onto the original) are shifted so copies do not hide each other.
    const count = (clip.pastes[pageId] ?? 0) + (pageId === clip.pageId ? 1 : 0);
    clip.pastes[pageId] = (clip.pastes[pageId] ?? 0) + 1;
    await controller.pasteObjects(clip.objects, count * PASTE_OFFSET);
    return true;
  }

  async duplicateSelection(): Promise<void> {
    await this.#owner()?.duplicateSelection();
  }

  // ── Selection ────────────────────────────────────────────────────────────

  registerPage(pageId: string, controller: PageController): () => void {
    this.#controllers.set(pageId, controller);
    return () => {
      if (this.#controllers.get(pageId) === controller) this.#controllers.delete(pageId);
      if (this.#selectionOwner === pageId) {
        this.#selectionOwner = null;
        this.selection = null;
      }
    };
  }

  /** Called by a page when its selection changes; only one page owns it. */
  reportSelection(pageId: string, info: SelectionInfo | null): void {
    if (info) {
      this.#takeSelection(pageId);
      this.selection = info;
      if (info.count === 1) this.#adoptStyles(info);
    } else if (this.#selectionOwner === pageId) {
      this.#selectionOwner = null;
      this.selection = null;
    }
  }

  /** Makes `pageId` the selection owner, clearing the selection of the previous one. */
  #takeSelection(pageId: string): void {
    if (this.#selectionOwner && this.#selectionOwner !== pageId) {
      const previous = this.#controllers.get(this.#selectionOwner);
      this.#selectionOwner = null;
      previous?.clearSelection();
    }
    this.#selectionOwner = pageId;
  }

  /** New content takes the style of the single object the user selected. */
  #adoptStyles(info: SelectionInfo): void {
    if (info.text) this.textStyle = { ...info.text };
    if (info.shape) this.shapeStyle = { ...info.shape };
    if (info.highlight) this.highlightColor = info.highlight;
  }

  #owner(): PageController | undefined {
    return this.#selectionOwner ? this.#controllers.get(this.#selectionOwner) : undefined;
  }

  /** Size of the page that holds the selection, in scene units. */
  get selectionPage(): PageRef | undefined {
    return this.pages.find((page) => page.id === this.#selectionOwner);
  }

  applyTextStyle(style: Partial<TextStyle>): void {
    this.textStyle = { ...this.textStyle, ...style };
    this.#owner()?.applyTextStyle(style);
  }

  applyShapeStyle(style: Partial<ShapeStyle>): void {
    this.shapeStyle = { ...this.shapeStyle, ...style };
    this.#owner()?.applyShapeStyle(style);
  }

  /** Points the selected link to a web address or a page of the document. */
  setLinkTarget(target: LinkTarget): void {
    this.#owner()?.setLinkTarget(target);
  }

  setHighlightColor(color: string): void {
    this.highlightColor = color;
    this.#owner()?.applyShapeStyle({}, color);
  }

  rotateSelection(degrees: number): void {
    this.#owner()?.rotateSelection(degrees);
  }

  flipSelection(axis: "x" | "y"): void {
    this.#owner()?.flipSelection(axis);
  }

  setSelectionOpacity(opacity: number): void {
    this.#owner()?.setSelectionOpacity(opacity);
  }

  arrangeSelection(action: ArrangeAction): void {
    this.#owner()?.arrangeSelection(action);
  }

  /** Aligns several objects to each other, or one to the page. */
  alignSelection(mode: AlignMode): void {
    this.#owner()?.alignSelection(mode);
  }

  distributeSelection(axis: "horizontal" | "vertical"): void {
    this.#owner()?.distributeSelection(axis);
  }

  groupSelection(): void {
    this.#owner()?.groupSelection();
  }

  ungroupSelection(): void {
    this.#owner()?.ungroupSelection();
  }

  setSelectionBounds(change: BoundsChange, keepRatio: boolean): void {
    this.#owner()?.setSelectionBounds(change, keepRatio);
  }

  toggleLockSelection(): void {
    this.#owner()?.toggleLockSelection();
  }

  deleteSelection(): void {
    const result = this.#owner()?.deleteSelection();
    if (result && result.locked > 0) {
      notifications.info(
        result.removed > 0
          ? t("Los objetos bloqueados no se eliminaron.")
          : t("Este objeto está bloqueado. Desbloquéalo para poder eliminarlo."),
      );
    }
  }

  nudgeSelection(dx: number, dy: number): void {
    this.#owner()?.nudgeSelection(dx, dy);
  }

  clearSelection(): void {
    this.#owner()?.clearSelection();
  }

  isEditingText(): boolean {
    return this.#owner()?.isEditingText() ?? false;
  }

  restoreOriginalText(): void {
    this.#owner()?.restoreOriginalText();
  }

  // ── History ──────────────────────────────────────────────────────────────

  /** Pages register a callback that writes any debounced edit to state. */
  registerFlusher(flush: () => void): () => void {
    this.#flushers.add(flush);
    return () => this.#flushers.delete(flush);
  }

  flushPendingEdits(): void {
    for (const flush of this.#flushers) flush();
  }

  undo(): void {
    this.flushPendingEdits();
    this.clearSelection();
    if (this.#historyIndex > 0) this.#goTo(this.#historyIndex - 1);
  }

  redo(): void {
    this.flushPendingEdits();
    this.clearSelection();
    if (this.#historyIndex < this.#history.length - 1) this.#goTo(this.#historyIndex + 1);
  }

  #goTo(index: number): void {
    const previousPageIndex = this.currentPageIndex;
    this.#historyIndex = index;
    this.#apply(this.#history[index]);
    this.#lastCommit = { key: null, at: 0 };
    if (!this.pages.some((page) => page.id === this.currentPageId)) {
      // Every step of the history has pages.
      this.currentPageId = this.pages[Math.min(previousPageIndex, this.pages.length - 1)].id;
    }
  }

  #resetHistory(snapshot: Snapshot): void {
    this.#apply(snapshot);
    this.#history = [snapshot];
    this.#historyIndex = 0;
    this.#savedIndex = 0;
    this.#lastCommit = { key: null, at: 0 };
  }

  #commit(changes: Partial<Snapshot>, coalesceKey?: string): void {
    const next: Snapshot = {
      pages: changes.pages ?? this.pages,
      annotations: changes.annotations ?? this.annotations,
      formValues: changes.formValues ?? this.formValues,
      decorations: changes.decorations === undefined ? this.decorations : changes.decorations,
    };
    const now = performance.now();
    let history = this.#history.slice(0, this.#historyIndex + 1);
    if (this.#savedIndex > this.#historyIndex) this.#savedIndex = -1;

    const top = history.length - 1;
    const coalesce =
      coalesceKey !== undefined &&
      this.#lastCommit.key === coalesceKey &&
      now - this.#lastCommit.at < COALESCE_WINDOW_MS &&
      top > 0 &&
      top !== this.#savedIndex;

    if (coalesce) {
      history[top] = next;
    } else {
      history.push(next);
    }
    if (history.length > HISTORY_LIMIT) {
      const overflow = history.length - HISTORY_LIMIT;
      history = history.slice(overflow);
      this.#savedIndex = this.#savedIndex >= overflow ? this.#savedIndex - overflow : -1;
    }

    this.#history = history;
    this.#historyIndex = history.length - 1;
    this.#apply(next);
    this.#lastCommit = { key: coalesceKey ?? null, at: now };
  }

  #apply(snapshot: Snapshot): void {
    const pagesChanged = snapshot.pages !== this.pages;
    this.pages = snapshot.pages;
    this.annotations = snapshot.annotations;
    this.decorations = snapshot.decorations;
    this.#applyFormValues(snapshot.formValues);
    if (pagesChanged) this.#refreshBookmarks();
    this.#scheduleAutosave();
  }

  #applyFormValues(next: FormValues): void {
    const previous = this.formValues;
    this.formValues = next;
    if (previous === next) return;
    for (const sourceId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[sourceId] === next[sourceId]) continue;
      const source = this.sources.get(sourceId);
      if (!source) continue;
      void syncFormStorage(source.pdf, next[sourceId] ?? {}, previous[sourceId] ?? {}).then(() => {
        this.formRevision = { ...this.formRevision, [sourceId]: (this.formRevision[sourceId] ?? 0) + 1 };
      });
    }
  }

  // ── Bookmarks ────────────────────────────────────────────────────────────

  /**
   * Rebuilds the bookmarks from the outline of each source, tied to the
   * current pages. Documents joined from several files get one bookmark per
   * file, holding that file's own bookmarks.
   */
  #refreshBookmarks(): void {
    const generation = ++this.#bookmarksGeneration;
    const pages = this.pages;
    this.#bookmarksTask = (async () => {
      const order: SourceDocument[] = [];
      for (const page of pages) {
        const source = this.sources.get(page.sourceId);
        if (source && !source.generated && !order.includes(source)) order.push(source);
      }
      const firstPage = new Map<string, string>();
      for (const page of pages) {
        const key = `${page.sourceId}:${page.sourceIndex}`;
        if (!firstPage.has(key)) firstPage.set(key, page.id);
      }
      const convert = (sourceId: string, items: SourceOutlineItem[]): Bookmark[] =>
        tieOutline(sourceId, items, (index) => firstPage.get(`${sourceId}:${index}`) ?? null);

      const perSource: Bookmark[] = [];
      for (const source of order) {
        let outline = this.#outlines.get(source.id);
        if (!outline) {
          outline = readOutline(source.pdf);
          this.#outlines.set(source.id, outline);
        }
        const children = convert(source.id, await outline);
        perSource.push({
          id: source.id,
          title: baseName(source.name),
          // `order` only holds sources of these pages.
          pageId: pages.find((page) => page.sourceId === source.id)!.id,
          top: null,
          children,
        });
      }
      if (generation !== this.#bookmarksGeneration) return;
      // A single file shows its own bookmarks; several, one bookmark per file.
      this.bookmarks = perSource.length === 1 ? perSource[0].children : perSource;
    })().catch((error) => console.error("No se pudieron leer los marcadores:", error));
  }

  // ── Saved works and projects ─────────────────────────────────────────────

  setRecovery(enabled: boolean): void {
    this.recoveryEnabled = enabled;
    setRecoveryEnabled(enabled);
    if (enabled) {
      void this.#saveSession();
      notifications.success(t("Se guardará una copia del trabajo en este navegador para poder recuperarlo."));
    } else {
      if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
      this.#autosaveTimer = null;
      void clearRecoveryCopies().then(() => this.refreshWorks());
    }
  }

  /** Lists the works kept in this browser. */
  async refreshWorks(): Promise<void> {
    this.savedWorks = await listSessions();
  }

  /** Keeps the open document in this browser until the user deletes it, and from then on saves it as it changes. */
  async saveWork(): Promise<void> {
    if (!this.hasDocument) return;
    this.keptWork = true;
    if (await this.#saveSession()) {
      notifications.success(t("Trabajo guardado en este navegador. Lo encontrarás en la pantalla de inicio."));
    }
    void this.refreshWorks();
  }

  async deleteWork(id: string): Promise<void> {
    await deleteSession(id);
    if (id === this.#workId) this.keptWork = false;
    await this.refreshWorks();
  }

  async openWork(id: string): Promise<void> {
    if (this.busy || this.hasDocument) return;
    const saved = await loadSession(id);
    if (!saved) {
      notifications.error(t("No se pudo recuperar el trabajo guardado."));
      await this.refreshWorks();
      return;
    }
    const restored = await this.#restore(saved, { id, kept: !!saved.kept });
    if (restored) notifications.success(t("Se recuperó «{name}».", { name: saved.documentName }));
  }

  /** Downloads the work as a project file (.ytapdf) that ytaPDF can open again. */
  async downloadProject(): Promise<void> {
    if (!this.hasDocument) return;
    this.flushPendingEdits();
    const { writeProject, PROJECT_EXTENSION } = await import("./project");
    downloadBytes(writeProject(this.#snapshotForStorage()), `${this.documentName}${PROJECT_EXTENSION}`, "application/zip");
    notifications.success(t("Proyecto descargado. Ábrelo con «Abrir proyecto» para seguir trabajando."));
  }

  async openProject(file: File): Promise<void> {
    if (this.busy) return;
    if (this.hasDocument) {
      notifications.info(t("Cierra el documento abierto para abrir un proyecto."));
      return;
    }
    const { readProject } = await import("./project");
    let saved: SavedSession;
    try {
      saved = await readProject(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      console.error("Error al abrir el proyecto:", error);
      notifications.error(t("«{name}» no es un proyecto de ytaPDF o está dañado.", { name: file.name }));
      return;
    }
    const restored = await this.#restore(saved);
    if (restored) notifications.success(t("Se abrió el proyecto «{name}».", { name: saved.documentName }));
  }

  async #restore(saved: SavedSession, work?: { id: string; kept: boolean }): Promise<boolean> {
    this.busy = t("Recuperando el trabajo…");
    try {
      for (const stored of saved.sources) {
        try {
          const source = await this.#loadSource(stored.name, stored.bytes, stored.id);
          if (source && saved.pages.every((page) => page.sourceId !== stored.id || page.sourceIndex === 0)) {
            source.generated = /^(Página en blanco|Documento en blanco|Blank page|Blank document)$/.test(stored.name);
          }
        } catch (error) {
          console.error(`No se pudo recuperar ${stored.name}:`, error);
        }
      }
      const pages = saved.pages
        .filter((page) => this.sources.has(page.sourceId))
        .map((page) => ({ ...page, rotation: page.rotation ?? 0 }));
      if (pages.length === 0) {
        notifications.error(t("No se pudo recuperar el trabajo guardado."));
        return false;
      }

      // Image URLs from the last visit are gone: register the bytes again.
      const urls = new Map(saved.images.map(({ url, bytes, mime }) => [url, registerImage({ bytes, mime })]));
      const annotations: Record<string, PageAnnotations> = {};
      for (const page of pages) {
        const data = saved.annotations[page.id];
        if (!data) continue;
        annotations[page.id] = { ...data, objects: data.objects.map((object) => relinkImages(object, urls)) };
      }
      const formValues = Object.fromEntries(
        Object.entries(saved.formValues ?? {}).filter(([sourceId]) => this.sources.has(sourceId)),
      );

      this.#startDocument(saved.documentName, { pages, annotations, formValues, decorations: saved.decorations ?? null }, work);
      this.ocr = Object.fromEntries(
        Object.entries(saved.ocr ?? {}).filter(([key]) => this.sources.has(key.slice(0, key.lastIndexOf(":")))),
      );
      return true;
    } finally {
      this.busy = null;
    }
  }

  #scheduleAutosave(): void {
    if (!this.recoveryEnabled && !this.keptWork) return;
    if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => {
      this.#autosaveTimer = null;
      void this.#saveSession();
    }, AUTOSAVE_DELAY_MS);
  }

  /** Everything needed to open the work again, images included. */
  #snapshotForStorage(): SavedSession & { id: string } {
    const usedSources = new Set(this.pages.map((page) => page.sourceId));
    const images: SavedSession["images"] = [];
    const collect = (object: Record<string, unknown>) => {
      const asset = typeof object.src === "string" ? getImageAsset(object.src) : undefined;
      if (asset && !images.some((image) => image.url === object.src)) images.push({ url: object.src as string, ...asset });
      if (Array.isArray(object.objects)) (object.objects as Record<string, unknown>[]).forEach(collect);
    };
    for (const data of Object.values(this.annotations)) data.objects.forEach(collect);
    return {
      version: 1,
      id: this.#workId,
      savedAt: Date.now(),
      documentName: this.documentName,
      kept: this.keptWork,
      sources: [...this.sources.values()]
        .filter((source) => usedSources.has(source.id))
        .map(({ id, name, bytes }) => ({ id, name, bytes })),
      pages: this.pages,
      annotations: this.annotations,
      formValues: this.formValues,
      images,
      decorations: this.decorations,
      ocr: Object.fromEntries(Object.entries(this.ocr).filter(([key]) => usedSources.has(key.slice(0, key.lastIndexOf(":"))))),
    };
  }

  async #saveSession(): Promise<boolean> {
    if ((!this.recoveryEnabled && !this.keptWork) || !this.hasDocument) return false;
    try {
      await saveSession(this.#snapshotForStorage());
      this.#autosaveFailed = false;
      return true;
    } catch (error) {
      console.error("No se pudo guardar la copia de recuperación:", error);
      if (!this.#autosaveFailed) {
        notifications.warning(t("No se pudo guardar el trabajo en el navegador: puede que no tenga espacio."));
      }
      this.#autosaveFailed = true;
      return false;
    }
  }

  // ── View ─────────────────────────────────────────────────────────────────

  registerViewport(hooks: ViewportHooks): () => void {
    this.#viewport = hooks;
    return () => {
      if (this.#viewport === hooks) this.#viewport = null;
    };
  }

  setZoom(zoom: number): void {
    this.zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;
  }

  zoomIn(): void {
    this.setZoom(ZOOM_STEPS.find((step) => step > this.zoom + 0.001) ?? ZOOM_MAX);
  }

  zoomOut(): void {
    this.setZoom([...ZOOM_STEPS].reverse().find((step) => step < this.zoom - 0.001) ?? ZOOM_MIN);
  }

  fitWidth(): void {
    const zoom = this.#viewport?.fitWidth();
    if (zoom) this.setZoom(zoom);
  }

  /** Zooms so the whole current page is visible, and brings it into view. */
  async fitPage(): Promise<void> {
    const pageId = this.currentPageId ?? this.pages[0]?.id;
    const zoom = pageId ? this.#viewport?.fitPage(pageId) : null;
    if (!pageId || !zoom) return;
    this.setZoom(zoom);
    await tick();
    requestAnimationFrame(() => this.#viewport?.scrollToPage(pageId, false));
  }
}

class UserFacingError extends Error {}

function todayLabel(): string {
  return formatDate(new Date(), { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Points saved image URLs (and those inside groups) to the images registered again. */
function relinkImages(object: Record<string, unknown>, urls: Map<string, string>): Record<string, unknown> {
  const src = typeof object.src === "string" ? urls.get(object.src) : undefined;
  const children = Array.isArray(object.objects)
    ? (object.objects as Record<string, unknown>[]).map((child) => relinkImages(child, urls))
    : undefined;
  if (!src && !children) return object;
  return { ...object, ...(src ? { src } : {}), ...(children ? { objects: children } : {}) };
}

export const editor = new Editor();
