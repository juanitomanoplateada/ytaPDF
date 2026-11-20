import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@cantoo/fontkit";
import { PDFDocument, PDFHexString, PDFRef, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { DrawContext, DrawResources } from "../export/drawing";
import { fallbackResources } from "./fallback";
import { appendUpdate } from "./incremental";
import { compressRanges, parseEraseRanges } from "./ranges";
import { TextDocument } from "./textDocument";
import type { NativeSpec, PageTextAnalysis, RunGlyph } from "./types";

const captured = vi.hoisted(() => [] as DrawResources[]);

// Lets the tests reach the resources a preview gives its drawing context.
vi.mock("../export/drawing", async (importOriginal) => {
  const original = await importOriginal<typeof import("../export/drawing")>();
  class RecordingContext extends original.DrawContext {
    constructor(doc: PDFDocument, resources: DrawResources) {
      super(doc, resources);
      captured.push(resources);
    }
  }
  return { ...original, DrawContext: RecordingContext };
});

const require = createRequire(import.meta.url);
const NOTO_SANS = new Uint8Array(readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")));

describe("erase ranges", () => {
  it("splits runs that are not consecutive and skips malformed entries", () => {
    const ranges = compressRanges([
      { path: "", op: 3, index: 4 },
      { path: "", op: 3, index: 1 },
      { path: "", op: 3, index: 2 },
      { path: "12/", op: 0, index: 7 },
    ]);
    expect(ranges).toEqual(["3:1-2", "3:4-4", "12/0:7-7"]);
    const parsed = parseEraseRanges([...ranges, "sin rango", "3:9-9"]);
    expect([...parsed.get("3")!]).toEqual([1, 2, 4, 9]);
    expect([...parsed.get("12/0")!]).toEqual([7]);
  });
});

describe("fallback fonts", () => {
  const context = (embedded: boolean) =>
    ({
      font: vi.fn(async () => ({ font: "fuente", canEncode: (char: string) => char !== "Ж", embedded })),
      missingGlyphs: new Set<string>(),
      unsupportedChars: new Set<string>(),
    }) as unknown as DrawContext & { font: ReturnType<typeof vi.fn> };

  it("records characters a standard font lacks as unsupported", async () => {
    const ctx = context(false);
    const fallback = await fallbackResources(ctx).fallbackFont({ kind: "fallback", family: "", weight: "normal", style: "normal" });
    expect(fallback.font).toBe("fuente");
    expect(fallback.prepare("aЖ")).toBe("a?");
    expect([...ctx.unsupportedChars]).toEqual(["Ж"]);
    // An empty family resolves to the default font.
    expect(ctx.font).toHaveBeenCalledWith({ kind: "standard", name: "Helvetica" });
  });

  it("records characters an embedded font lacks as missing glyphs", async () => {
    const ctx = context(true);
    const fallback = await fallbackResources(ctx).fallbackFont({ kind: "fallback", family: "Noto Sans", weight: "bold", style: "italic" });
    fallback.prepare("Ж");
    expect([...ctx.missingGlyphs]).toEqual(["Ж"]);
  });
});

describe("incremental updates", () => {
  it("needs the cross-reference offset of the base", async () => {
    const doc = await PDFDocument.create();
    await expect(appendUpdate(new TextEncoder().encode("%PDF-1.7\n"), doc, 0, [])).rejects.toThrow(
      "No se encontró la tabla de referencias del PDF.",
    );
  });

  it("writes only the trailer entries the document has and skips missing objects", async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const base = await source.save({ useObjectStreams: false });
    const doc = await PDFDocument.load(base);
    const largest = doc.context.largestObjectNumber;
    doc.context.trailerInfo.Info = undefined;
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of("0a"), PDFHexString.of("0a")]);
    const withId = new TextDecoder("latin1").decode(await appendUpdate(base, doc, largest, [PDFRef.of(9999)]));
    expect(withId).toMatch(/\/Root \d+ 0 R \/ID \[/);
    expect(withId.slice(base.length)).not.toContain("/Info");

    doc.context.trailerInfo = {} as typeof doc.context.trailerInfo;
    const bare = new TextDecoder("latin1").decode(await appendUpdate(base, doc, largest, []));
    expect(bare.slice(base.length)).toMatch(/trailer\n<< \/Size \d+ \/Prev \d+ >>/);
  });
});

/** A spec that writes `text` where `analysis` found its first line, with the line's own font. */
function rewrite(analysis: PageTextAnalysis, text: string): NativeSpec {
  const unit = analysis.lines[0];
  const font = analysis.fonts[unit.lines[0][0].font];
  const size = unit.lines[0][0].size;
  let x = 0;
  const glyphs: RunGlyph[] = [...text].map((char) => {
    const [code, length, width] = font.glyphs[char];
    const glyph = { text: char, code, length, width, x, y: 0 };
    x += (width / 1000) * size;
    return glyph;
  });
  return {
    id: "prueba",
    erase: unit.erase,
    insertAfter: unit.insertAfter,
    matrix: [unit.u[0], unit.u[1], -unit.u[1], unit.u[0], unit.origin[0], unit.origin[1]],
    renderMode: 0,
    runs: [{ font: { kind: "original", sample: font.sample, key: font.key }, size, color: { space: "gray", components: [0] }, glyphs }],
    underlines: [],
  };
}

describe("TextDocument", () => {
  async function open() {
    const source = await PDFDocument.create();
    const helvetica = await source.embedFont(StandardFonts.Helvetica);
    source.addPage([300, 200]).drawText("Hola", { x: 20, y: 100, size: 14, font: helvetica });
    source.addPage([300, 200]);
    return TextDocument.open(await source.save(), undefined, fontkit);
  }

  it("analyses each page once", async () => {
    const document = await open();
    expect(await document.analyze(0)).toBe(await document.analyze(0));
  });

  it("keeps working after a task fails", async () => {
    const document = await open();
    await expect(document.analyze(7)).rejects.toThrow();
    expect((await document.analyze(0)).lines).toHaveLength(1);
  });

  it("embeds the fonts a preview is given and fails the text whose font is missing", async () => {
    const document = await open();
    const spec = rewrite(await document.analyze(0), "Hola");
    spec.runs.push({
      font: { kind: "fallback", family: '"Noto Sans", sans-serif', weight: "normal", style: "normal" },
      size: 14,
      color: { space: "gray", components: [0] },
      glyphs: [{ text: "Ж", x: 40, y: 0 }],
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await document.derive(0, [spec], {})).failed).toEqual(["prueba"]);
    errors.mockRestore();
    const embedded = await document.derive(0, [spec], { "noto-sans:regular": NOTO_SANS });
    expect(embedded.failed).toEqual([]);
    expect(embedded.unsupported).toEqual([]);
  });

  it("restores pages that had no content and never loads images", async () => {
    const document = await open();
    const page = document.doc.getPage(1);
    const before = page.node.keys().map(String);
    const result = await document.derive(1, [], {});
    expect(result.failed).toEqual([]);
    expect(page.node.keys().map(String)).toEqual(before);
    await expect(captured.at(-1)!.loadImage("blob:x")).rejects.toThrow("Sin imágenes");
  });
});
