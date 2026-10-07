import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SourceDocument } from "../editor.svelte";
import { embeddedFontBytes } from "../embeddedFonts";
import { resolveFont } from "../fonts";
import { openDerivedPdf, syncFormStorage, type FormValue } from "../pdfjs";
import type { DeriveResult, WorkerRequest, WorkerResponse } from "./protocol";
import type { NativeSpec, PageTextAnalysis } from "./types";

type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Preview {
  pdf: Promise<PDFDocumentProxy>;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
}

export interface PreviewHandle {
  pdf: Promise<PDFDocumentProxy>;
  release(): void;
}

/** How long an unused preview is kept, in case it is needed again (undo, scrolling back). */
const KEEP_UNUSED_MS = 30_000;
const MAX_UNUSED = 8;

function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${text.length.toString(36)}`;
}

/** A stable key for a set of specs (or one spec). */
export function specKey(specs: NativeSpec | NativeSpec[]): string {
  return hash(JSON.stringify(specs));
}

/**
 * Main-thread side of the text worker: reads the editable text of pages and
 * produces previews of pages with their text edited, rendered by PDF.js like
 * any other page.
 */
class TextEditing {
  #worker: Worker | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #opened = new Map<string, Promise<unknown>>();
  readonly #analyses = new Map<string, Promise<PageTextAnalysis>>();
  readonly #previews = new Map<string, Preview>();
  readonly #formSync = new WeakMap<PDFDocumentProxy, Record<string, FormValue>>();

  #ensureWorker(): Worker {
    if (!this.#worker) {
      const worker = new Worker(new URL("./textWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = this.#pending.get(event.data.id);
        if (!pending) return;
        this.#pending.delete(event.data.id);
        if (event.data.error !== undefined) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      };
      worker.onerror = (event) => {
        console.error("El analizador de texto se detuvo:", event.message);
        this.reset();
      };
      this.#worker = worker;
    }
    return this.#worker;
  }

  #call<T>(request: Request, transfer: Transferable[] = []): Promise<T> {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  #open(source: SourceDocument): Promise<unknown> {
    let opening = this.#opened.get(source.id);
    if (!opening) {
      opening = this.#call({ type: "open", sourceId: source.id, bytes: source.bytes, password: source.password });
      opening.catch(() => this.#opened.delete(source.id));
      this.#opened.set(source.id, opening);
    }
    return opening;
  }

  /** The editable lines and paragraphs of a page. */
  analyze(source: SourceDocument, pageIndex: number): Promise<PageTextAnalysis> {
    const key = `${source.id}:${pageIndex}`;
    let analysis = this.#analyses.get(key);
    if (!analysis) {
      analysis = this.#open(source).then(() =>
        this.#call<PageTextAnalysis>({ type: "analyze", sourceId: source.id, pageIndex }),
      );
      analysis.catch(() => this.#analyses.delete(key));
      this.#analyses.set(key, analysis);
    }
    return analysis;
  }

  /**
   * A PDF.js document of the source with one page's text replaced as `specs`
   * say. Previews are shared while in use; call `release` when done.
   */
  preview(source: SourceDocument, pageIndex: number, specs: NativeSpec[]): PreviewHandle {
    const key = `${source.id}:${pageIndex}:${specKey(specs)}`;
    let preview = this.#previews.get(key);
    if (!preview) {
      const pdf = this.#build(source, pageIndex, specs);
      preview = { pdf, users: 0, timer: null, lastUsed: Date.now() };
      pdf.catch(() => this.#previews.delete(key));
      this.#previews.set(key, preview);
    }
    const entry = preview;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.users++;
    entry.lastUsed = Date.now();
    let released = false;
    return {
      pdf: entry.pdf,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.users > 0) return;
        entry.lastUsed = Date.now();
        entry.timer = setTimeout(() => this.#drop(key), KEEP_UNUSED_MS);
        this.#trim();
      },
    };
  }

  async #build(source: SourceDocument, pageIndex: number, specs: NativeSpec[]): Promise<PDFDocumentProxy> {
    await this.#open(source);
    const fonts: Record<string, Uint8Array> = {};
    for (const spec of specs) {
      for (const run of spec.runs) {
        if (run.font.kind !== "fallback") continue;
        const resolved = resolveFont(run.font.family || undefined, run.font.weight, run.font.style);
        if (resolved.kind !== "embedded") continue;
        const name = `${resolved.family}:${resolved.variant}`;
        fonts[name] ??= await embeddedFontBytes(resolved.family, resolved.variant);
      }
    }
    const result = await this.#call<DeriveResult>({ type: "derive", sourceId: source.id, pageIndex, specs, fonts });
    if (result.failed.length > 0) console.warn("Algunos textos editados no se pudieron aplicar:", result.failed);
    return openDerivedPdf(result.bytes);
  }

  /** Makes a preview's form fields show the values typed in the editor. */
  async syncForms(pdf: PDFDocumentProxy, values: Record<string, FormValue>): Promise<void> {
    const previous = this.#formSync.get(pdf) ?? {};
    if (previous === values) return;
    await syncFormStorage(pdf, values, previous);
    this.#formSync.set(pdf, values);
  }

  #drop(key: string): void {
    const preview = this.#previews.get(key);
    if (!preview || preview.users > 0) return;
    this.#previews.delete(key);
    if (preview.timer) clearTimeout(preview.timer);
    void preview.pdf.then((pdf) => pdf.loadingTask.destroy()).catch(() => {});
  }

  /** Keeps memory bounded: only a few unused previews are kept. */
  #trim(): void {
    const unused = [...this.#previews.entries()].filter(([, p]) => p.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of unused.slice(0, Math.max(0, unused.length - MAX_UNUSED))) this.#drop(key);
  }

  /** Forgets everything (the document was closed). */
  reset(): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const pending of this.#pending.values()) pending.reject(new Error("El analizador de texto se reinició."));
    this.#pending.clear();
    this.#opened.clear();
    this.#analyses.clear();
    for (const key of [...this.#previews.keys()]) {
      const preview = this.#previews.get(key)!;
      preview.users = 0;
      this.#drop(key);
    }
  }
}

export const textEditing = new TextEditing();
