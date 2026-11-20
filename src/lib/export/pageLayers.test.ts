import { PDFDocument, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addInvisibleText, invisibleTextOperators } from "./ocrLayer";

const mocks = vi.hoisted(() => ({
  renderPage: vi.fn(),
  pageSpecs: vi.fn(async () => []),
  renderablePage: vi.fn(),
  paintAnnotations: vi.fn(async (..._args: unknown[]) => {}),
  ensureFontsFor: vi.fn(async () => {}),
}));

vi.mock("../pdfjs", () => ({ MAX_CANVAS_PIXELS: 16_777_216, renderPage: mocks.renderPage }));
vi.mock("../embeddedFonts", () => ({ ensureFontsFor: mocks.ensureFontsFor }));
vi.mock("../thumbnails", () => ({
  pageSpecs: mocks.pageSpecs,
  renderablePage: mocks.renderablePage,
  paintAnnotations: mocks.paintAnnotations,
  withoutNativeText: (data: { objects: Record<string, unknown>[] }) => ({ ...data, objects: data.objects.filter((o) => !o.ytaNative) }),
}));

const { rasterizePage } = await import("./raster");

afterEach(() => vi.unstubAllGlobals());

// ── Invisible OCR text ──────────────────────────────────────────────────

const quad = (x: number, y: number, w: number, h: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

describe("invisible text", () => {
  it("writes each word squeezed to its box, replacing what the font cannot encode", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const operators = invisibleTextOperators(
      [
        { text: "Hola", quad: quad(10, 10, 40, 10) },
        { text: "Жук", quad: quad(60, 10, 0.01, 10) },
        { text: "  ", quad: quad(0, 0, 10, 10) },
        { text: "x", quad: quad(0, 0, 0, 10) },
        { text: "y", quad: quad(0, 0, 10, 0) },
        { text: "ancho", quad: quad(0, 0, 100000, 10) },
      ],
      font,
      "F1",
      (char) => char !== "Ж" && char !== "у" && char !== "к",
    );
    const text = operators.map(String).join("\n");
    expect(text.match(/Tf/g)).toHaveLength(3);
    expect(text).toContain("1 Tz");
    expect(text).toContain("1000 Tz");
    expect(text).toContain("3 Tr");
  });

  it("writes nothing when no word can be placed", async () => {
    const zero = { widthOfTextAtSize: () => 0, encodeText: () => "" } as unknown as PDFFont;
    expect(invisibleTextOperators([{ text: "a", quad: quad(0, 0, 10, 10) }], zero, "F1", () => true)).toEqual([]);
  });

  it("adds the words to a page with the font in its resources", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(addInvisibleText(page, [], font, () => true)).toBe(0);
    expect(addInvisibleText(page, [{ text: " ", quad: quad(0, 0, 10, 10) }], font, () => true)).toBe(0);
    expect(addInvisibleText(page, [{ text: "a", quad: quad(0, 0, 10, 10) }, { text: "b", quad: quad(20, 0, 10, 10) }], font, () => true)).toBe(2);
  });
});

// ── Rasterised pages ────────────────────────────────────────────────────

describe("rasterising pages", () => {
  const page = { id: "p", sourceId: "s", sourceIndex: 0, width: 200, height: 100, rotation: 0 } as never;
  const source = { id: "s" } as never;
  let context: { fillRect: ReturnType<typeof vi.fn>; globalCompositeOperation: string; fillStyle: string } | null;
  let blob: Blob | null;
  let canvas: { width: number; height: number; getContext: () => unknown; toBlob: (resolve: (b: Blob | null) => void, type: string, quality: number) => void };

  beforeEach(() => {
    context = { fillRect: vi.fn(), globalCompositeOperation: "", fillStyle: "" };
    blob = new Blob([new Uint8Array([7])]);
    canvas = { width: 400, height: 200, getContext: () => context, toBlob: vi.fn((resolve) => resolve(blob)) };
    vi.stubGlobal("document", { createElement: () => canvas });
    mocks.renderPage.mockReset();
    mocks.renderPage.mockReturnValue({ promise: Promise.resolve() });
    mocks.renderablePage.mockReset();
    mocks.renderablePage.mockResolvedValue({ proxy: {}, done: vi.fn() });
    mocks.paintAnnotations.mockClear();
  });

  it("renders PNG pages at the requested resolution, without notes, links or native text", async () => {
    const data = { version: "7", objects: [{ type: "Rect" }, { type: "IText", ytaKind: "note" }, { type: "Rect", ytaKind: "link" }, { type: "NativeLine", ytaNative: {} }] };
    const bytes = await rasterizePage(page, source, data, { s: { campo: "x" } }, { dpi: 144, format: "image/png" });
    expect(bytes).toEqual(new Uint8Array([7]));
    expect(mocks.renderablePage).toHaveBeenCalledWith(source, page, [], { campo: "x" });
    expect(mocks.renderPage.mock.calls[0][2]).toBe(2);
    expect((mocks.paintAnnotations.mock.calls[0][1] as { objects: unknown[] }).objects).toEqual([{ type: "Rect" }]);
    expect(context!.fillRect).not.toHaveBeenCalled();
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png", 0.92);
    expect(canvas.width).toBe(0);
  });

  it("paints JPEG pages on white and skips empty annotations", async () => {
    await rasterizePage(page, source, { version: "7", objects: [] }, {}, { dpi: 72, format: "image/jpeg", quality: 0.5 });
    expect(context!.fillRect).toHaveBeenCalled();
    expect(context!.globalCompositeOperation).toBe("source-over");
    expect(mocks.paintAnnotations).not.toHaveBeenCalled();
    expect(mocks.renderablePage).toHaveBeenCalledWith(source, page, [], {});
    await rasterizePage(page, source, undefined, {}, { dpi: 72, format: "image/png" });
    expect(mocks.paintAnnotations).not.toHaveBeenCalled();
  });

  it("releases the page when rendering fails and reports canvases it cannot use", async () => {
    const done = vi.fn();
    mocks.renderablePage.mockResolvedValueOnce({ proxy: {}, done });
    mocks.renderPage.mockReturnValueOnce({ promise: Promise.reject(new Error("cancelado")) });
    await expect(rasterizePage(page, source, undefined, {}, { dpi: 72, format: "image/png" })).rejects.toThrow("cancelado");
    expect(done).toHaveBeenCalled();
    context = null;
    await expect(rasterizePage(page, source, undefined, {}, { dpi: 72, format: "image/png" })).rejects.toThrow("No se pudo preparar la imagen de la página.");
    context = { fillRect: vi.fn(), globalCompositeOperation: "", fillStyle: "" };
    blob = null;
    await expect(rasterizePage(page, source, undefined, {}, { dpi: 72, format: "image/png" })).rejects.toThrow("No se pudo generar la imagen de la página.");
  });
});
