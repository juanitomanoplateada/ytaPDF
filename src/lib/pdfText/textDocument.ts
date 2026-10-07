import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { DrawContext, type FontkitLike } from "../export/drawing";
import type { EmbeddedFamilyId, FontVariant } from "../fonts";
import { analyzePage, type FontProgramReader } from "./analyze";
import { applyNativeSpecs } from "./apply";
import { fallbackResources } from "./fallback";
import { FontCache } from "./fonts";
import { appendUpdate, normalizedBase } from "./incremental";
import type { DeriveResult } from "./protocol";
import type { NativeSpec, PageTextAnalysis } from "./types";

/**
 * A source document opened for text editing: it reads the editable text of
 * its pages and builds previews of pages with edited text.
 */
export class TextDocument {
  readonly #analyses = new Map<number, PageTextAnalysis>();
  readonly #fonts: FontCache;
  /** Previews modify the document and then put it back: one task at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    /** Bytes the document was parsed from; previews are appended to them. */
    readonly base: Uint8Array,
    readonly doc: PDFDocument,
    private readonly fontkit: FontkitLike & FontProgramReader,
  ) {
    this.#fonts = new FontCache(doc.context);
  }

  static async open(bytes: Uint8Array, password: string | undefined, fontkit: unknown): Promise<TextDocument> {
    const base = await normalizedBase(bytes, password);
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    return new TextDocument(base, doc, fontkit as FontkitLike & FontProgramReader);
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  analyze(pageIndex: number): Promise<PageTextAnalysis> {
    return this.#exclusive(async () => {
      let analysis = this.#analyses.get(pageIndex);
      if (!analysis) {
        analysis = analyzePage(this.doc.getPage(pageIndex), this.#fonts, this.fontkit);
        this.#analyses.set(pageIndex, analysis);
      }
      return analysis;
    });
  }

  /**
   * Applies the specs to a page, writes the result as an update appended to
   * the base and then undoes the changes, so the parsed document is reused
   * for the next preview instead of being parsed again.
   */
  derive(pageIndex: number, specs: NativeSpec[], fonts: Record<string, Uint8Array>): Promise<DeriveResult> {
    return this.#exclusive(async () => {
      const { doc, base } = this;
      const { context } = doc;
      const largest = context.largestObjectNumber;
      const page = doc.getPage(pageIndex);
      const saved = ["Contents", "Resources"].map((key) => [PDFName.of(key), page.node.get(PDFName.of(key))] as const);
      try {
        const drawing = new DrawContext(doc, {
          loadImage: () => Promise.reject(new Error("Sin imágenes")),
          loadFont: async (family: EmbeddedFamilyId, variant: FontVariant) => {
            const bytes = fonts[`${family}:${variant}`];
            if (!bytes) throw new Error(`Falta la fuente ${family} ${variant}`);
            return bytes;
          },
          fontkit: this.fontkit,
        });
        const report = await applyNativeSpecs(page, specs, new FontCache(context), fallbackResources(drawing));
        const bytes = await appendUpdate(base, doc, largest, [page.ref]);
        return { bytes, failed: report.failed, unsupported: [...drawing.unsupportedChars, ...drawing.missingGlyphs] };
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) page.node.delete(key);
          else page.node.set(key, value);
        }
        for (const [ref] of context.enumerateIndirectObjects()) {
          if (ref.objectNumber > largest) context.delete(ref);
        }
        context.largestObjectNumber = largest;
        // Fonts embedded for this preview belong to objects that no longer exist.
        (doc as unknown as { fonts: unknown[] }).fonts = [];
      }
    });
  }
}
