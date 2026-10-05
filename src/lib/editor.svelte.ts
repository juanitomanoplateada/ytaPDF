import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizeRotation, rotateAnnotations, type QuarterTurn } from "./annotationTransforms";
import { DEFAULT_FONT_FAMILY } from "./fonts";
import { getImageAsset, importImage, registerImage, releaseImageAssets } from "./images";
import { notifications } from "./notifications.svelte";
import { makeBlankPdf } from "./blankPdf";
import { openPdf, PasswordCancelledError, syncFormStorage, type FormValue } from "./pdfjs";
import {
  clearSession,
  loadSession,
  recoveryEnabled,
  saveSession,
  setRecoveryEnabled,
  summarize,
  type SavedSession,
  type SessionSummary,
} from "./session";
import { clearThumbnailCache } from "./thumbnails";

/** A PDF file the user opened. Its bytes stay untouched until export. */
export interface SourceDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** Password the user typed to open it, kept in memory only. */
  password?: string;
  pdf: PDFDocumentProxy;
  pageCount: number;
}

/**
 * One page of the document being edited. Pages point into a source document,
 * so reordering, deleting, rotating or merging never rewrites PDF bytes until
 * export.
 */
export interface PageRef {
  id: string;
  sourceId: string;
  /** Zero-based page index inside the source document. */
  sourceIndex: number;
  /** Clockwise rotation added by the user on top of the page's own. */
  rotation: number;
  /** Size of the PDF.js viewport at scale 1 (all rotations applied). */
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

export type DrawTool = "rect" | "ellipse" | "line" | "arrow" | "highlight" | "redact";
export type Tool = "select" | "text" | DrawTool;
export type ObjectKind = "text" | "image" | "signature" | DrawTool;
export type ArrangeAction = "front" | "forward" | "backward" | "back";

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  underline: boolean;
}

export interface ShapeStyle {
  stroke: string;
  /** `null` leaves the shape transparent. */
  fill: string | null;
  strokeWidth: number;
}

/** A drawn signature: an SVG path whose bounding box starts at the origin. */
export interface SignatureData {
  path: string;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
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
  /** Style of the first shape, line or signature in the selection. */
  shape: ShapeStyle | null;
  /** Colour of the first highlight in the selection. */
  highlight: string | null;
  locked: boolean;
  canRaise: boolean;
  canLower: boolean;
}

export interface CopiedObjects {
  objects: Record<string, unknown>[];
  text: string;
}

/** Operations a mounted page exposes to the toolbar and keyboard shortcuts. */
export interface PageController {
  addImage(url: string): Promise<void>;
  addSignature(signature: SignatureData): void;
  addText(content: string): void;
  applyTextStyle(style: Partial<TextStyle>): void;
  applyShapeStyle(style: Partial<ShapeStyle>, highlight?: string): void;
  rotateSelection(degrees: number): void;
  flipSelection(axis: "x" | "y"): void;
  setSelectionOpacity(opacity: number): void;
  arrangeSelection(action: ArrangeAction): void;
  toggleLockSelection(): void;
  deleteSelection(): { removed: number; locked: number };
  duplicateSelection(): Promise<void>;
  copySelection(): CopiedObjects | null;
  pasteObjects(objects: Record<string, unknown>[], offset: number): Promise<void>;
  nudgeSelection(dx: number, dy: number): void;
  clearSelection(): void;
  isEditingText(): boolean;
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
}

interface ViewportHooks {
  scrollToPage(pageId: string, smooth: boolean): void;
  fitWidth(): number | null;
}

const HISTORY_LIMIT = 100;
/** Edits sharing a key within this window become a single undo step. */
const COALESCE_WINDOW_MS = 1200;
const AUTOSAVE_DELAY_MS = 1500;
/** How far each paste on the same page is shifted, in scene units. */
const PASTE_OFFSET = 14;

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
  return fileName.replace(/\.pdf$/i, "").trim() || "documento";
}

function pagesLabel(count: number): string {
  return count === 1 ? "1 página" : `${count} páginas`;
}

class Editor {
  /** Opened files, indexed by id. Not reactive: pages reference them by id. */
  readonly sources = new Map<string, SourceDocument>();

  pages = $state.raw<PageRef[]>([]);
  annotations = $state.raw<Record<string, PageAnnotations>>({});
  formValues = $state.raw<FormValues>({});
  /** Bumped per source when its form values reach PDF.js, to repaint pages. */
  formRevision = $state.raw<Record<string, number>>({});
  documentName = $state("");
  currentPageId = $state<string | null>(null);
  zoom = $state(1);
  tool = $state<Tool>("select");
  view = $state<"editor" | "organizer">("editor");
  sidebarOpen = $state(false);
  selection = $state<SelectionInfo | null>(null);
  /** Style for new text, mirrored from the last text the user styled. */
  textStyle = $state<TextStyle>({ ...DEFAULT_TEXT_STYLE });
  shapeStyle = $state<ShapeStyle>({ ...DEFAULT_SHAPE_STYLE });
  highlightColor = $state(DEFAULT_HIGHLIGHT);
  busy = $state<string | null>(null);
  passwordRequest = $state<PasswordRequest | null>(null);
  signatureOpen = $state(false);
  shortcutsOpen = $state(false);
  hasClipboard = $state(false);
  recoveryEnabled = $state(recoveryEnabled());
  recovery = $state<SessionSummary | null>(null);

  #history = $state.raw<Snapshot[]>([]);
  #historyIndex = $state(0);
  /** History index matching the last export, or -1 if it no longer exists. */
  #savedIndex = $state(0);
  #lastCommit: { key: string | null; at: number } = { key: null, at: 0 };

  #controllers = new Map<string, PageController>();
  #selectionOwner: string | null = null;
  #flushers = new Set<() => void>();
  #viewport: ViewportHooks | null = null;
  /** Copied objects, the page they came from and how many times each page received them. */
  #clipboard: (CopiedObjects & { pageId: string; pastes: Record<string, number> }) | null = null;
  #autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  #autosaveFailed = false;

  hasDocument = $derived(this.pages.length > 0);
  canUndo = $derived(this.#historyIndex > 0);
  canRedo = $derived(this.#historyIndex < this.#history.length - 1);
  isDirty = $derived(this.#historyIndex !== this.#savedIndex);
  currentPageIndex = $derived(
    Math.max(0, this.pages.findIndex((page) => page.id === this.currentPageId)),
  );

  // ── Documents ────────────────────────────────────────────────────────────

  async openFiles(files: Iterable<File>): Promise<void> {
    const list = [...files];
    if (list.length === 0 || this.busy) return;

    const added: PageRef[] = [];
    const failures: string[] = [];
    let firstName: string | null = null;

    this.busy = list.length > 1 ? "Abriendo documentos…" : "Abriendo documento…";
    try {
      for (const file of list) {
        try {
          const source = await this.#loadSource(file.name, new Uint8Array(await file.arrayBuffer()));
          if (!source) continue;
          firstName ??= source.name;
          added.push(...(await this.#createPageRefs(source)));
        } catch (error) {
          console.error(`Error al abrir ${file.name}:`, error);
          failures.push(error instanceof UserFacingError ? error.message : `No se pudo abrir «${file.name}». El archivo puede estar dañado.`);
        }
      }
    } finally {
      this.busy = null;
    }

    for (const message of failures) notifications.error(message);
    if (added.length === 0) return;

    if (!this.hasDocument) {
      this.documentName = baseName(firstName ?? "documento");
      this.#resetHistory({ pages: added, annotations: {}, formValues: {} });
      this.currentPageId = added[0].id;
      this.view = "editor";
      this.recovery = null;
    } else {
      this.#commit({ pages: [...this.pages, ...added] });
      notifications.success(`Se añadieron ${pagesLabel(added.length)} al final.`, {
        label: "Deshacer",
        run: () => this.undo(),
      });
    }
  }

  async #loadSource(name: string, bytes: Uint8Array, id = createId("src")): Promise<SourceDocument | null> {
    if (!looksLikePdf(bytes)) {
      throw new UserFacingError(`«${name}» no es un archivo PDF.`);
    }

    let opened;
    try {
      opened = await openPdf(bytes, (incorrect) => this.#askPassword(name, incorrect));
    } catch (error) {
      if (error instanceof PasswordCancelledError) {
        notifications.info(`No se abrió «${name}» porque requiere contraseña.`);
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
    releaseImageAssets();
    clearThumbnailCache();
    this.#clipboard = null;
    this.hasClipboard = false;
    if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = null;
    void clearSession();

    this.#resetHistory({ pages: [], annotations: {}, formValues: {} });
    this.formRevision = {};
    this.documentName = "";
    this.currentPageId = null;
    this.tool = "select";
    this.view = "editor";
    this.sidebarOpen = false;
    this.zoom = 1;
  }

  async exportPdf(): Promise<void> {
    if (!this.hasDocument) return;
    const done = await this.#export(this.pages, `${this.documentName}_ytaPDF.pdf`);
    if (done) this.#savedIndex = this.#historyIndex;
  }

  /** Exports only some pages, in the current order, as a separate file. */
  async exportPages(pageIds: string[]): Promise<void> {
    const pages = this.pages.filter((page) => pageIds.includes(page.id));
    if (pages.length === 0) return;
    await this.#export(pages, `${this.documentName}_${pages.length === 1 ? "pagina" : "paginas"}_ytaPDF.pdf`);
  }

  async #export(pages: PageRef[], fileName: string): Promise<boolean> {
    if (this.busy) return false;
    this.flushPendingEdits();

    this.busy = "Generando PDF…";
    try {
      const { exportDocument } = await import("./export");
      const { bytes, warnings } = await exportDocument({
        pages,
        annotations: this.annotations,
        formValues: this.formValues,
        sources: this.sources,
        title: this.documentName,
      });
      downloadPdf(bytes, fileName);
      if (warnings.length > 0) {
        for (const warning of warnings) notifications.warning(warning);
      } else {
        notifications.success(
          pages.length === this.pages.length ? "PDF exportado correctamente." : `Se exportaron ${pagesLabel(pages.length)}.`,
        );
      }
      return true;
    } catch (error) {
      console.error("Error al exportar:", error);
      notifications.error(
        "No se pudo generar el PDF. Si el problema continúa, prueba a quitar la última anotación añadida.",
      );
      return false;
    } finally {
      this.busy = null;
    }
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
      notifications.info("Un documento necesita al menos una página. Para empezar de nuevo, cierra el documento.");
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
      removed === 1 ? `Página ${firstIndex + 1} eliminada.` : `Se eliminaron ${pagesLabel(removed)}.`,
      { label: "Deshacer", run: () => this.undo() },
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
    const reference = this.pages[index] ?? this.pages[this.pages.length - 1];
    const width = reference?.width ?? 595.28;
    const height = reference?.height ?? 841.89;
    const source = await this.#loadSource("Página en blanco", makeBlankPdf(width, height));
    if (!source) return;
    const [page] = await this.#createPageRefs(source);
    const pages = [...this.pages];
    pages.splice(index + 1, 0, page);
    this.#commit({ pages });
    notifications.success(`Página en blanco insertada en la posición ${index + 2}.`, {
      label: "Deshacer",
      run: () => this.undo(),
    });
  }

  goToPage(pageId: string, smooth = true): void {
    this.currentPageId = pageId;
    this.#viewport?.scrollToPage(pageId, smooth);
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
      notifications.error("Abre la vista de edición para añadir imágenes.");
      return;
    }
    let url: string;
    try {
      url = await importImage(file);
    } catch (error) {
      console.error("Error al importar la imagen:", error);
      notifications.error(`No se pudo usar «${file.name}» como imagen.`);
      return;
    }
    await controller.addImage(url);
  }

  insertSignature(signature: SignatureData): void {
    this.signatureOpen = false;
    const controller = this.#targetController(this.currentPageId);
    if (!controller) {
      notifications.error("Abre la vista de edición para añadir la firma.");
      return;
    }
    this.tool = "select";
    controller.addSignature(signature);
  }

  addTextFromClipboard(content: string): void {
    const text = content.replace(/\r\n?/g, "\n").trim();
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
      if (this.#selectionOwner && this.#selectionOwner !== pageId) {
        const previous = this.#controllers.get(this.#selectionOwner);
        this.#selectionOwner = null;
        previous?.clearSelection();
      }
      this.#selectionOwner = pageId;
      this.selection = info;
      if (info.count === 1) {
        if (info.text) this.textStyle = { ...info.text };
        if (info.shape) this.shapeStyle = { ...info.shape };
        if (info.highlight) this.highlightColor = info.highlight;
      }
    } else if (this.#selectionOwner === pageId) {
      this.#selectionOwner = null;
      this.selection = null;
    }
  }

  #owner(): PageController | undefined {
    return this.#selectionOwner ? this.#controllers.get(this.#selectionOwner) : undefined;
  }

  applyTextStyle(style: Partial<TextStyle>): void {
    this.textStyle = { ...this.textStyle, ...style };
    this.#owner()?.applyTextStyle(style);
  }

  applyShapeStyle(style: Partial<ShapeStyle>): void {
    this.shapeStyle = { ...this.shapeStyle, ...style };
    this.#owner()?.applyShapeStyle(style);
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

  toggleLockSelection(): void {
    this.#owner()?.toggleLockSelection();
  }

  deleteSelection(): void {
    const result = this.#owner()?.deleteSelection();
    if (result && result.locked > 0) {
      notifications.info(
        result.removed > 0
          ? "Los objetos bloqueados no se eliminaron."
          : "Este objeto está bloqueado. Desbloquéalo para poder eliminarlo.",
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
      this.currentPageId = this.pages[Math.min(previousPageIndex, this.pages.length - 1)]?.id ?? null;
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
    this.pages = snapshot.pages;
    this.annotations = snapshot.annotations;
    this.#applyFormValues(snapshot.formValues);
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

  // ── Recovery ─────────────────────────────────────────────────────────────

  setRecovery(enabled: boolean): void {
    this.recoveryEnabled = enabled;
    setRecoveryEnabled(enabled);
    if (enabled) {
      void this.#saveSession();
      notifications.success("Se guardará una copia del trabajo en este navegador para poder recuperarlo.");
    } else {
      if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
      this.#autosaveTimer = null;
      void clearSession();
    }
  }

  /** Looks for work saved in a previous visit. */
  async checkRecovery(): Promise<void> {
    if (!this.recoveryEnabled || this.hasDocument) return;
    const saved = await loadSession();
    this.recovery = saved ? summarize(saved) : null;
  }

  async discardRecovery(): Promise<void> {
    this.recovery = null;
    await clearSession();
  }

  async restoreSession(): Promise<void> {
    const saved = await loadSession();
    this.recovery = null;
    if (!saved || this.busy) return;

    this.busy = "Recuperando el trabajo…";
    try {
      for (const stored of saved.sources) {
        try {
          await this.#loadSource(stored.name, stored.bytes, stored.id);
        } catch (error) {
          console.error(`No se pudo recuperar ${stored.name}:`, error);
        }
      }
      const pages = saved.pages
        .filter((page) => this.sources.has(page.sourceId))
        .map((page) => ({ ...page, rotation: page.rotation ?? 0 }));
      if (pages.length === 0) {
        notifications.error("No se pudo recuperar el trabajo guardado.");
        return;
      }

      // Image URLs from the last visit are gone: register the bytes again.
      const urls = new Map(saved.images.map(({ url, bytes, mime }) => [url, registerImage({ bytes, mime })]));
      const annotations: Record<string, PageAnnotations> = {};
      for (const page of pages) {
        const data = saved.annotations[page.id];
        if (!data) continue;
        annotations[page.id] = {
          ...data,
          objects: data.objects.map((object) =>
            typeof object.src === "string" && urls.has(object.src) ? { ...object, src: urls.get(object.src) } : object,
          ),
        };
      }
      const formValues = Object.fromEntries(
        Object.entries(saved.formValues ?? {}).filter(([sourceId]) => this.sources.has(sourceId)),
      );

      this.documentName = saved.documentName;
      this.#resetHistory({ pages, annotations, formValues });
      this.currentPageId = pages[0].id;
      this.view = "editor";
      notifications.success(`Se recuperó «${saved.documentName}».`);
    } finally {
      this.busy = null;
    }
  }

  #scheduleAutosave(): void {
    if (!this.recoveryEnabled) return;
    if (this.#autosaveTimer) clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => {
      this.#autosaveTimer = null;
      void this.#saveSession();
    }, AUTOSAVE_DELAY_MS);
  }

  async #saveSession(): Promise<void> {
    if (!this.recoveryEnabled || !this.hasDocument) return;
    const usedSources = new Set(this.pages.map((page) => page.sourceId));
    const images: SavedSession["images"] = [];
    for (const data of Object.values(this.annotations)) {
      for (const object of data.objects) {
        const asset = typeof object.src === "string" ? getImageAsset(object.src) : undefined;
        if (asset && !images.some((image) => image.url === object.src)) images.push({ url: object.src as string, ...asset });
      }
    }
    try {
      await saveSession({
        version: 1,
        savedAt: Date.now(),
        documentName: this.documentName,
        sources: [...this.sources.values()]
          .filter((source) => usedSources.has(source.id))
          .map(({ id, name, bytes }) => ({ id, name, bytes })),
        pages: this.pages,
        annotations: this.annotations,
        formValues: this.formValues,
        images,
      });
      this.#autosaveFailed = false;
    } catch (error) {
      console.error("No se pudo guardar la copia de recuperación:", error);
      if (!this.#autosaveFailed) {
        notifications.warning("No se pudo guardar la copia de recuperación: puede que el navegador no tenga espacio.");
      }
      this.#autosaveFailed = true;
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
}

class UserFacingError extends Error {}

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const editor = new Editor();
