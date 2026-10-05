import type { PDFDocumentProxy } from "pdfjs-dist";
import { DEFAULT_FONT_FAMILY } from "./fonts";
import { importImage, releaseImageAssets } from "./images";
import { notifications } from "./notifications.svelte";
import { openPdf, PasswordCancelledError } from "./pdfjs";
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
 * so reordering, deleting or merging never rewrites PDF bytes until export.
 */
export interface PageRef {
  id: string;
  sourceId: string;
  /** Zero-based page index inside the source document. */
  sourceIndex: number;
  /** Size of the PDF.js viewport at scale 1 (page rotation applied). */
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

export type Tool = "select" | "text";

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  underline: boolean;
}

export interface SelectionInfo {
  kind: "text" | "image" | "multiple";
  count: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  /** Style of the selected text, or of the first text in a multiple selection. */
  text: TextStyle | null;
}

/** Operations a mounted page exposes to the toolbar and keyboard shortcuts. */
export interface PageController {
  addImage(url: string): Promise<void>;
  applyTextStyle(style: Partial<TextStyle>): void;
  rotateSelection(degrees: number): void;
  flipSelection(axis: "x" | "y"): void;
  setSelectionOpacity(opacity: number): void;
  deleteSelection(): void;
  nudgeSelection(dx: number, dy: number): void;
  clearSelection(): void;
  isEditingText(): boolean;
}

export interface PasswordRequest {
  fileName: string;
  incorrect: boolean;
  resolve: (password: string | null) => void;
}

interface Snapshot {
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
}

interface ViewportHooks {
  scrollToPage(pageId: string, smooth: boolean): void;
  fitWidth(): number | null;
}

const HISTORY_LIMIT = 100;
/** Edits sharing a key within this window become a single undo step. */
const COALESCE_WINDOW_MS = 1200;

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

class Editor {
  /** Opened files, indexed by id. Not reactive: pages reference them by id. */
  readonly sources = new Map<string, SourceDocument>();

  pages = $state.raw<PageRef[]>([]);
  annotations = $state.raw<Record<string, PageAnnotations>>({});
  documentName = $state("");
  currentPageId = $state<string | null>(null);
  zoom = $state(1);
  tool = $state<Tool>("select");
  view = $state<"editor" | "organizer">("editor");
  sidebarOpen = $state(false);
  selection = $state<SelectionInfo | null>(null);
  /** Style for new text, mirrored from the last text the user styled. */
  textStyle = $state<TextStyle>({ ...DEFAULT_TEXT_STYLE });
  busy = $state<string | null>(null);
  passwordRequest = $state<PasswordRequest | null>(null);

  #history = $state.raw<Snapshot[]>([]);
  #historyIndex = $state(0);
  /** History index matching the last export, or -1 if it no longer exists. */
  #savedIndex = $state(0);
  #lastCommit: { key: string | null; at: number } = { key: null, at: 0 };

  #controllers = new Map<string, PageController>();
  #selectionOwner: string | null = null;
  #flushers = new Set<() => void>();
  #viewport: ViewportHooks | null = null;

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
          const source = await this.#loadSource(file);
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
      this.#resetHistory({ pages: added, annotations: {} });
      this.currentPageId = added[0].id;
      this.view = "editor";
    } else {
      this.#commit({ pages: [...this.pages, ...added], annotations: this.annotations });
      notifications.success(
        added.length === 1 ? "Se añadió 1 página al final." : `Se añadieron ${added.length} páginas al final.`,
        { label: "Deshacer", run: () => this.undo() },
      );
    }
  }

  async #loadSource(file: File): Promise<SourceDocument | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikePdf(bytes)) {
      throw new UserFacingError(`«${file.name}» no es un archivo PDF.`);
    }

    let opened;
    try {
      opened = await openPdf(bytes, (incorrect) => this.#askPassword(file.name, incorrect));
    } catch (error) {
      if (error instanceof PasswordCancelledError) {
        notifications.info(`No se abrió «${file.name}» porque requiere contraseña.`);
        return null;
      }
      throw error;
    }

    const source: SourceDocument = {
      id: createId("src"),
      name: file.name,
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

    this.#resetHistory({ pages: [], annotations: {} });
    this.documentName = "";
    this.currentPageId = null;
    this.tool = "select";
    this.view = "editor";
    this.sidebarOpen = false;
    this.zoom = 1;
  }

  async exportPdf(): Promise<void> {
    if (!this.hasDocument || this.busy) return;
    this.flushPendingEdits();

    this.busy = "Generando PDF…";
    try {
      const { exportDocument } = await import("./export");
      const { bytes, warnings } = await exportDocument({
        pages: this.pages,
        annotations: this.annotations,
        sources: this.sources,
        title: this.documentName,
      });
      downloadPdf(bytes, `${this.documentName}_ytaPDF.pdf`);
      this.#savedIndex = this.#historyIndex;
      if (warnings.length > 0) {
        for (const warning of warnings) notifications.warning(warning);
      } else {
        notifications.success("PDF exportado correctamente.");
      }
    } catch (error) {
      console.error("Error al exportar:", error);
      notifications.error(
        "No se pudo generar el PDF. Si el problema continúa, prueba a quitar la última anotación añadida.",
      );
    } finally {
      this.busy = null;
    }
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  deletePage(pageId: string): void {
    if (this.pages.length <= 1) {
      notifications.info("Un documento necesita al menos una página. Para empezar de nuevo, cierra el documento.");
      return;
    }
    const index = this.pages.findIndex((page) => page.id === pageId);
    if (index === -1) return;

    this.flushPendingEdits();
    const pages = this.pages.filter((page) => page.id !== pageId);
    const { [pageId]: _removed, ...annotations } = this.annotations;
    this.#commit({ pages, annotations });

    if (this.currentPageId === pageId) {
      this.currentPageId = pages[Math.min(index, pages.length - 1)].id;
    }
    notifications.info(`Página ${index + 1} eliminada.`, {
      label: "Deshacer",
      run: () => this.undo(),
    });
  }

  /** Moves a page so it lands at `targetIndex` in the resulting order. */
  movePage(pageId: string, targetIndex: number): void {
    const from = this.pages.findIndex((page) => page.id === pageId);
    const to = Math.max(0, Math.min(targetIndex, this.pages.length - 1));
    if (from === -1 || from === to) return;

    const pages = [...this.pages];
    const [moved] = pages.splice(from, 1);
    pages.splice(to, 0, moved);
    this.#commit({ pages, annotations: this.annotations });
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
    this.#commit({ pages: this.pages, annotations }, coalesceKey);
    return annotations[pageId];
  }

  async addImage(file: File, pageId = this.currentPageId): Promise<void> {
    const controller = (pageId && this.#controllers.get(pageId)) || this.#controllers.values().next().value;
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
      if (info.text && info.count === 1) this.textStyle = { ...info.text };
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

  rotateSelection(degrees: number): void {
    this.#owner()?.rotateSelection(degrees);
  }

  flipSelection(axis: "x" | "y"): void {
    this.#owner()?.flipSelection(axis);
  }

  setSelectionOpacity(opacity: number): void {
    this.#owner()?.setSelectionOpacity(opacity);
  }

  deleteSelection(): void {
    this.#owner()?.deleteSelection();
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
    const snapshot = this.#history[index];
    this.#historyIndex = index;
    this.pages = snapshot.pages;
    this.annotations = snapshot.annotations;
    this.#lastCommit = { key: null, at: 0 };
    if (!this.pages.some((page) => page.id === this.currentPageId)) {
      this.currentPageId = this.pages[Math.min(previousPageIndex, this.pages.length - 1)]?.id ?? null;
    }
  }

  #resetHistory(snapshot: Snapshot): void {
    this.pages = snapshot.pages;
    this.annotations = snapshot.annotations;
    this.#history = [snapshot];
    this.#historyIndex = 0;
    this.#savedIndex = 0;
    this.#lastCommit = { key: null, at: 0 };
  }

  #commit(next: Snapshot, coalesceKey?: string): void {
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
    this.pages = next.pages;
    this.annotations = next.annotations;
    this.#lastCommit = { key: coalesceKey ?? null, at: now };
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
