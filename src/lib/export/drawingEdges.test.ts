import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCanvas } from "canvas";
import fontkit from "@cantoo/fontkit";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Matrix } from "../geometry";
import { DrawContext, drawOnPage, type Drawable, type DrawResources, type FontkitLike } from "./drawing";

const require = createRequire(import.meta.url);
const NOTO_SANS = new Uint8Array(readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")));
const NOTO_SC = new Uint8Array(readFileSync(require.resolve("@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf")));

afterEach(() => vi.restoreAllMocks());

const IDENTITY: Matrix = [1, 0, 0, 1, 100, 100];
const VIEWPORT = [1, 0, 0, -1, 0, 400];
const BLACK = { r: 0, g: 0, b: 0 };

const noImages: DrawResources = { loadImage: () => Promise.reject(new Error("Sin imágenes")) };

async function draw(drawables: Drawable[], resources: DrawResources = noImages) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const context = new DrawContext(doc, resources);
  await drawOnPage(page, drawables, VIEWPORT, context);
  const bytes = await doc.save({ useObjectStreams: false });
  return { context, text: new TextDecoder("latin1").decode(bytes) };
}

const text = (content: string, changes: Record<string, unknown> = {}): Drawable =>
  ({
    kind: "text",
    matrix: IDENTITY,
    opacity: 1,
    lines: [{ text: content, x: 0, baseline: 0 }],
    fontSize: 12,
    color: BLACK,
    underline: false,
    ...changes,
  }) as Drawable;

const pngBytes = () => {
  const canvas = createCanvas(2, 2);
  canvas.getContext("2d").fillRect(0, 0, 1, 1);
  return { png: new Uint8Array(canvas.toBuffer("image/png")), jpeg: new Uint8Array(canvas.toBuffer("image/jpeg")) };
};

describe("drawing images", () => {
  it("embeds each image once, as PNG or JPEG", async () => {
    const { png, jpeg } = pngBytes();
    const loadImage = vi.fn(async (src: string) => (src === "a" ? { bytes: png, mime: "image/png" as const } : { bytes: jpeg, mime: "image/jpeg" as const }));
    const image = (src: string): Drawable => ({ kind: "image", matrix: IDENTITY, opacity: 1, src, width: 20, height: 20 });
    const { context, text: pdf } = await draw([image("a"), image("a"), image("b")], { loadImage });
    expect(loadImage).toHaveBeenCalledTimes(2);
    expect(context.failedImages.size).toBe(0);
    // Two images, plus the transparency mask of the PNG.
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(3);
  });

  it("records images it cannot load and carries on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { context } = await draw([{ kind: "image", matrix: IDENTITY, opacity: 1, src: "roto", width: 20, height: 20 }]);
    expect([...context.failedImages]).toEqual(["roto"]);
  });
});

describe("drawing shapes", () => {
  const base = { matrix: IDENTITY, opacity: 1 };

  it("skips shapes with neither fill nor stroke", async () => {
    const { text: pdf } = await draw([
      { ...base, kind: "path", d: "M 0 0 L 10 10", stroke: null, fill: null, strokeWidth: 1, lineCap: "butt", lineJoin: "miter" },
      { ...base, kind: "rect", width: 10, height: 10, fill: null, stroke: BLACK, strokeWidth: 0 },
      { ...base, kind: "ellipse", rx: 5, ry: 5, fill: null, stroke: null, strokeWidth: 2 },
    ]);
    expect(pdf).not.toMatch(/\b(f|S|B)\n/);
  });

  it("fills and strokes paths, rectangles and ellipses", async () => {
    const { text: pdf } = await draw([
      { ...base, kind: "path", d: "M 0 0 L 10 10 L 0 10 Z", stroke: null, fill: BLACK, strokeWidth: 1, lineCap: "round", lineJoin: "round" },
      { ...base, opacity: Number.NaN, kind: "path", d: "M 0 0 L 10 10", stroke: BLACK, fill: null, strokeWidth: 2, lineCap: "square", lineJoin: "bevel" },
      { ...base, kind: "rect", width: 10, height: 10, fill: BLACK, stroke: null, strokeWidth: 0 },
      { ...base, kind: "ellipse", rx: 5, ry: 5, fill: null, stroke: BLACK, strokeWidth: 2 },
    ]);
    expect(pdf.length).toBeGreaterThan(0);
  });
});

describe("drawing text", () => {
  it("decorates only lines with visible text", async () => {
    const decorated = { underline: true, linethrough: true };
    const rectangles = async (content: string) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 400]);
      const drawRectangle = vi.spyOn(page, "drawRectangle");
      await drawOnPage(page, [text(content, decorated)], VIEWPORT, new DrawContext(doc, noImages));
      return drawRectangle.mock.calls.length;
    };
    expect(await rectangles("   ")).toBe(0);
    expect(await rectangles("Hola")).toBe(2);
  });

  it("needs fonts to embed families that are not standard", async () => {
    await expect(draw([text("Hola", { fontFamily: '"Noto Sans", sans-serif' })])).rejects.toThrow(
      "Faltan los recursos para incrustar fuentes.",
    );
  });

  it("writes other scripts with their font, once per weight, and reports when it cannot load", async () => {
    const loadScriptFont = vi.fn(async () => NOTO_SC);
    const resources: DrawResources = { ...noImages, loadScriptFont, fontkit: fontkit as unknown as FontkitLike };
    const { context } = await draw([text("中文 1, 中"), text("中", { fontWeight: "bold" }), text("文")], resources);
    expect(context.unsupportedChars.size).toBe(0);
    expect(loadScriptFont.mock.calls).toEqual([
      ["noto-sans-sc", false],
      ["noto-sans-sc", true],
    ]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: DrawResources = { ...noImages, loadScriptFont: async () => Promise.reject(new Error("sin red")), fontkit: fontkit as unknown as FontkitLike };
    const { context: failed } = await draw([text("中")], failing);
    expect([...failed.unsupportedChars]).toEqual(["中"]);
    expect(errors).toHaveBeenCalled();
  });

  it("does without script fonts when it has no way to load them", async () => {
    const { context } = await draw([text("中")]);
    expect([...context.unsupportedChars]).toEqual(["中"]);
  });

  it("says embedded fonts cannot encode an empty character", async () => {
    const doc = await PDFDocument.create();
    const context = new DrawContext(doc, { ...noImages, loadFont: async () => NOTO_SANS, fontkit: fontkit as unknown as FontkitLike });
    const usable = await context.font({ kind: "embedded", family: "noto-sans", variant: "regular" });
    expect(usable.canEncode("")).toBe(false);
    expect(usable.canEncode("a")).toBe(true);
  });
});
