// @vitest-environment jsdom
import { Rect, StaticCanvas } from "fabric";
import { describe, expect, it, vi } from "vitest";
import {
  bakeNativeScale,
  createNativeText,
  isNative,
  isNativeData,
  markDeleted,
  NativeBlock,
  NativeLine,
  nativeSpec,
  nativeSpecsFromData,
  originalFontIndex,
  originalFontLabel,
  placeBaseline,
  plainFontFamily,
  pointInQuad,
  substitutedChars,
  toPlainTextData,
  toScene,
  type NativeText,
} from "./nativeText";
import type { Matrix } from "./geometry";
import type { AnalyzedChar, AnalyzedFont, PageTextAnalysis, TextUnit } from "./pdfText/types";

const VIEWPORT: Matrix = [1, 0, 0, -1, 0, 800];
const BLACK = { space: "gray" as const, components: [0] };
const RED = { space: "rgb" as const, components: [1, 0, 0] };

/** Every glyph of these fonts is 500/1000 wide, the space 250. */
const font = (changes: Partial<AnalyzedFont> = {}): AnalyzedFont => ({
  key: "F",
  name: "Prueba",
  families: ['Pru"eba'],
  bold: false,
  italic: false,
  serif: false,
  monospace: false,
  sample: "0:0",
  glyphs: Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz-"].map((c, i) => [c, [97 + i, 1, 500]]).concat([[" ", [32, 1, 250]]])),
  space: 250,
  ...changes,
});

const chars = (text: string, changes: Partial<AnalyzedChar> = {}): AnalyzedChar[] =>
  [...text].map((c, i) => ({ text: c, font: 0, size: 10, color: BLACK, rise: 0, x0: i * 5, x1: i * 5 + 5, ...changes }));

const unit = (lines: AnalyzedChar[][], changes: Partial<TextUnit> = {}): TextUnit => ({
  id: "l:0:0",
  kind: "line",
  lines,
  joins: lines.slice(1).map(() => " "),
  align: "left",
  origin: [100, 700],
  u: [1, 0],
  v: [0, 1],
  hScale: 1,
  width: 100,
  naturalWidth: 100,
  leading: 0,
  size: 10,
  erase: ["0:0-3"],
  insertAfter: "3",
  alpha: 1,
  renderMode: 0,
  quads: [[[100, 698], [200, 698], [200, 708], [100, 708]]],
  editable: true,
  justifyLast: false,
  ...changes,
});

const analysis = (fonts: AnalyzedFont[] = [font()]): PageTextAnalysis => ({ fonts, lines: [], paragraphs: [], paragraphOf: [] });

describe("font markers", () => {
  it("reads the original font index and label from CSS stacks", () => {
    expect(originalFontIndex(5)).toBeUndefined();
    expect(originalFontIndex("Arial")).toBeUndefined();
    expect(originalFontIndex(' yta-f2 , "Arial"')).toBe(2);
    expect(originalFontLabel('yta-f0, "Mi Fuente", sans-serif')).toBe("Mi Fuente");
    expect(originalFontLabel("yta-f0, Arial")).toBeUndefined();
    expect(originalFontLabel("Arial")).toBeUndefined();
    expect(plainFontFamily('yta-f0, "Arial", sans-serif')).toBe('"Arial", sans-serif');
    expect(plainFontFamily("yta-f0")).toBe("Helvetica, Arial, sans-serif");
  });
});

describe("creating native text", () => {
  it("makes a line with the document's fonts, colours, rises and joins", () => {
    const fonts = [font(), font({ key: "S", serif: true, bold: true, italic: true }), font({ key: "M", monospace: true })];
    const object = createNativeText(
      unit([chars("ab"), chars("cd", { font: 1, color: RED, rise: 2 }), [], chars("e", { font: 2 })], { joins: [" ", "\n", " "] }),
      analysis(fonts),
      VIEWPORT,
    );
    expect(object).toBeInstanceOf(NativeLine);
    expect(object.text).toBe("ab cd\ne");
    expect(object.ytaNative.fonts.map((f) => f.css)).toEqual([
      'yta-f0, "Prueba", Helvetica, Arial, sans-serif',
      'yta-f1, "Prueba", "Times New Roman", Times, serif',
      'yta-f2, "Prueba", "Courier New", Courier, monospace',
    ]);
    expect(object.ytaNative.colors.map(([hex]) => hex)).toEqual(["#000000", "#ff0000"]);
    const styles = object.styles as Record<number, Record<number, Record<string, unknown>>>;
    expect(styles[0][3]).toMatchObject({ fontWeight: "bold", fontStyle: "italic", deltaY: -2 });
    expect(isNative(object)).toBe(true);
    expect(isNative(new Rect())).toBe(false);
    expect(isNative(null)).toBe(false);
  });

  it("makes blocks of paragraphs and justified lines, with their leading", () => {
    const paragraph = createNativeText(unit([chars("abc"), chars("def")], { kind: "paragraph", leading: 12, align: "center", hScale: 0 }), analysis(), VIEWPORT);
    expect(paragraph).toBeInstanceOf(NativeBlock);
    expect(paragraph.textAlign).toBe("center");
    expect(paragraph.lineHeight).toBeCloseTo(12 / (10 * 1.13));
    expect(paragraph.scaleX).toBe(1);
    const justified = createNativeText(unit([chars("abc")], { align: "justify" }), analysis(), VIEWPORT);
    expect(justified).toBeInstanceOf(NativeBlock);
    expect(justified.textAlign).toBe("justify-left");
    expect(justified.lineHeight).toBe(1.16);
  });

  it("follows the text's direction, mirroring and slant", () => {
    const turned = createNativeText(unit([chars("ab")], { u: [0, 1], v: [-1, 0] }), analysis(), VIEWPORT);
    expect(turned.angle).toBeCloseTo(-90);
    const mirrored = createNativeText(unit([chars("ab")], { v: [0, -1] }), analysis(), VIEWPORT);
    expect(mirrored.flipY).toBe(true);
    const slanted = createNativeText(unit([chars("ab")], { v: [0.3, 1] }), analysis(), VIEWPORT);
    expect(slanted.skewX).toBeLessThan(-1);
    const straight = createNativeText(unit([chars("ab")], { v: [0, 0] }), analysis(), VIEWPORT);
    expect(straight.skewX).toBe(0);
  });

  it("places the start of the first baseline where asked", () => {
    const object = createNativeText(unit([chars("ab")]), analysis(), VIEWPORT);
    placeBaseline(object, [10, 20]);
    const before = object.left;
    placeBaseline(object, [30, 20]);
    expect(object.left - before).toBeCloseTo(20);
  });
});

describe("measuring and drawing", () => {
  it("measures characters with the original widths while the style matches the font", () => {
    const object = createNativeText(unit([chars("ab")]), analysis(), VIEWPORT) as NativeLine;
    const style = { fontFamily: object.ytaNative.fonts[0].css, fontSize: 20, fontWeight: "normal", fontStyle: "normal" };
    expect(object._measureChar("a", style as never, undefined as never, undefined as never)).toEqual({ width: 10, kernedWidth: 10 });
    expect(object._measureChar("Z", style as never, undefined as never, undefined as never).width).not.toBe(10);
    const bold = { ...style, fontWeight: "bold" };
    expect(object._measureChar("a", bold as never, undefined as never, undefined as never).width).not.toBe(10);
    const block = createNativeText(unit([chars("ab")], { kind: "paragraph" }), analysis(), VIEWPORT) as NativeBlock;
    expect(block._measureChar("a", style as never, undefined as never, undefined as never)).toEqual({ width: 10, kernedWidth: 10 });
    expect(block._measureChar("a", { ...style, fontFamily: "Arial" } as never, undefined as never, undefined as never).width).not.toBe(10);
  });

  it("draws each character where it was measured, unless the page already shows it", () => {
    const canvas = new StaticCanvas(undefined, { width: 300, height: 300 });
    for (const kind of ["line", "paragraph"] as const) {
      const object = createNativeText(unit([chars("ab")], { kind }), analysis(), VIEWPORT);
      const renderChar = vi.spyOn(object as unknown as { _renderChar: () => void }, "_renderChar");
      canvas.add(object);
      canvas.renderAll();
      const drawn = renderChar.mock.calls.length;
      expect(drawn).toBeGreaterThan(0);
      object.ytaGhost = true;
      const ctx = canvas.getContext();
      object._render(ctx);
      expect(renderChar).toHaveBeenCalledTimes(drawn);
      // Characters without a box are skipped.
      const boxes = (object as unknown as { __charBounds: unknown[][] }).__charBounds[0].length;
      (object as unknown as { _renderChars: (...args: unknown[]) => void })._renderChars("fillText", ctx, ["a", "b", "c", "d", "e"], 0, 0, 0);
      expect(renderChar).toHaveBeenCalledTimes(drawn + boxes);
      canvas.remove(object);
    }
  });
});

describe("justified blocks", () => {
  const justified = (text: string, width: number, changes: Partial<TextUnit> = {}, lineCount?: number) => {
    const object = createNativeText(unit([chars(text)], { align: "justify", width, naturalWidth: 0, justifyLast: true, ...changes }), analysis(), VIEWPORT) as NativeBlock;
    if (lineCount !== undefined) object.ytaNative.lineCount = lineCount;
    else delete (object.ytaNative as Partial<typeof object.ytaNative>).lineCount;
    object.initDimensions();
    return object;
  };
  const lineWidths = (object: NativeBlock) => object.textLines.map((_, i) => object.getLineWidth(i));

  it("stretches wrapped lines and the last one while the text keeps its lines", () => {
    const object = justified("ab cd ef gh", 30);
    expect(object.textLines.length).toBeGreaterThan(1);
    const bounds = (object as unknown as { __charBounds: { left: number }[][] }).__charBounds;
    expect(bounds[0].at(-1)!.left).toBeGreaterThan(0);
    expect(lineWidths(object).length).toBe(object.textLines.length);
    const kept = justified("ab cd", 300, {}, 5);
    expect(kept.textLines).toHaveLength(1);
    const more = justified("ab cd", 300, {}, 0);
    expect(more.textLines).toHaveLength(1);
  });

  it("justifies forced breaks only after a hyphen", () => {
    const hyphen = createNativeText(
      unit([chars("ab cd-"), chars("ef gh"), chars("ij")], { align: "justify", joins: ["\n", "\n"], width: 200, naturalWidth: 0 }),
      analysis(),
      VIEWPORT,
    ) as NativeBlock;
    // Lines that are not justified are measured when first needed.
    hyphen.getLineWidth(1);
    const bounds = (hyphen as unknown as { __charBounds: { left: number; width: number }[][] }).__charBounds;
    // The space of the hyphenated line is widened; the one of the next forced line is not.
    expect(bounds[0][2].width).toBeGreaterThan(bounds[1][2].width);
  });

  it("can be built justified before it has native data", () => {
    // Fabric lays the text out from its constructor: this threw while the
    // helpers were private methods, which do not exist yet at that point.
    const block = new NativeBlock("ab cd", { textAlign: "justify-left", width: 10 } as never);
    expect(block.textLines.length).toBeGreaterThan(1);
  });
});

describe("editing helpers", () => {
  it("lists characters the original fonts cannot draw", () => {
    const object = createNativeText(unit([chars("ab")]), analysis(), VIEWPORT);
    object.set("text", "ab Zñ");
    object.initDimensions();
    expect(substitutedChars(object)).toEqual(["Z", "ñ"]);
    object.set("fontWeight", "bold");
    object.set("styles", {});
    object.initDimensions();
    expect(substitutedChars(object)).toEqual([]);
  });

  it("marks deleted text and turns resizing into font sizes", () => {
    const object = createNativeText(unit([chars("ab")]), analysis(), VIEWPORT);
    markDeleted(object);
    expect(object.visible).toBe(false);
    expect(object.ytaNative.deleted).toBe(true);

    const line = createNativeText(unit([chars("ab")]), analysis(), VIEWPORT);
    expect(bakeNativeScale(line)).toBe(false);
    // Assigned directly: Fabric's setter would clamp a zero scale.
    Object.assign(line, { scaleY: 2, scaleX: 0 });
    (line.styles as Record<number, Record<number, Record<string, unknown>>>)[0][0] = { fill: "#000" };
    expect(bakeNativeScale(line)).toBe(true);
    expect(line.fontSize).toBe(20);
    expect(line.scaleX).toBe(0.5);
    Object.assign(line, { scaleY: 0 });
    expect(bakeNativeScale(line)).toBe(false);
    const block = createNativeText(unit([chars("ab")], { kind: "paragraph" }), analysis(), VIEWPORT);
    const width = block.width;
    block.set({ scaleY: 1.5, styles: undefined as never });
    expect(bakeNativeScale(block)).toBe(true);
    expect(block.width).toBeCloseTo(width * 1.5);
  });

  it("turns copied native text into plain text", () => {
    expect(toPlainTextData({ type: "Rect" })).toEqual({ type: "Rect" });
    expect(isNativeData({ ytaNative: null })).toBe(false);
    expect(toPlainTextData({ type: "NativeBlock", ytaNative: {}, fontFamily: "yta-f0, Arial", textAlign: "justify-left" })).toEqual({
      type: "Textbox",
      fontFamily: "Arial",
      styles: [],
      textAlign: "left",
      opacity: 1,
    });
    expect(toPlainTextData({ type: "NativeLine", ytaNative: {}, fontFamily: 3, textAlign: "center", opacity: 0.5 })).toMatchObject({
      type: "IText",
      fontFamily: "Helvetica, Arial, sans-serif",
      textAlign: "center",
      opacity: 0.5,
    });
    expect(toPlainTextData({ type: "NativeLine", ytaNative: {}, textAlign: 7 })).toMatchObject({ textAlign: 7 });
  });
});

describe("export specs", () => {
  const object = (text = "ab", changes: Partial<TextUnit> = {}) => createNativeText(unit([chars(text)], changes), analysis(), VIEWPORT);

  it("only erases when the text is not drawn", () => {
    const o = object();
    expect(nativeSpec(o, VIEWPORT, false).runs).toEqual([]);
    markDeleted(o);
    expect(nativeSpec(o, VIEWPORT).runs).toEqual([]);
    const empty = object();
    empty.set("text", "   ");
    expect(nativeSpec(empty, VIEWPORT).runs).toEqual([]);
    const hidden = object();
    hidden.set("visible", false);
    expect(nativeSpec(hidden, VIEWPORT).runs).toEqual([]);
  });

  it("draws original glyphs, fallbacks and substitutes in separate runs", () => {
    const o = object("ab");
    o.set("text", "ab Ñ");
    const styles = o.styles as Record<number, Record<number, Record<string, unknown>>>;
    styles[0][3] = { fontFamily: "Arial", fontWeight: 700, fontStyle: "italic", fontSize: 12, fill: "#FF0000", deltaY: 3 };
    o.initDimensions();
    const spec = nativeSpec(o, VIEWPORT);
    expect(spec.runs.map((run) => run.font)).toEqual([
      { kind: "original", sample: "0:0", key: "F" },
      { kind: "fallback", family: "Arial", weight: "700", style: "italic" },
    ]);
    expect(spec.runs[0].glyphs.map((g) => g.text)).toEqual(["a", "b", " "]);
    expect(spec.runs[1].color).toEqual({ space: "rgb", components: [1, 0, 0] });
    expect(spec.runs[1].glyphs[0].y).toBeLessThan(0);
    const substitute = object("ab");
    substitute.set("text", "aZ");
    substitute.initDimensions();
    expect(nativeSpec(substitute, VIEWPORT).runs[1].font).toMatchObject({ kind: "fallback", substitute: true });
  });

  it("skips spaces no font draws and reads odd style values with defaults", () => {
    const o = object("ab");
    o.set("text", "a Ñ");
    const styles = o.styles as Record<number, Record<number, Record<string, unknown>>>;
    styles[0][1] = { fontFamily: "Arial" };
    styles[0][2] = { fontFamily: "Arial", fontWeight: true };
    o.initDimensions();
    const spec = nativeSpec(o, VIEWPORT);
    expect(spec.runs.flatMap((run) => run.glyphs.map((g) => g.text))).toEqual(["a", "Ñ"]);
    expect(spec.runs[1].font).toEqual({ kind: "fallback", family: "Arial", weight: "normal", style: "normal" });
  });

  it("keeps opacity changes and joins underlines of neighbouring characters", () => {
    const o = object("abcd");
    o.set("opacity", 0.5);
    const styles = o.styles as Record<number, Record<number, Record<string, unknown>>>;
    for (const i of [0, 1, 3]) styles[0][i] = { ...styles[0][i], underline: true };
    styles[0][3].fill = "#ff0000";
    styles[0][1].fontSize = 20;
    o.initDimensions();
    const spec = nativeSpec(o, VIEWPORT);
    expect(spec.opacity).toBe(0.5);
    expect(spec.underlines).toHaveLength(3);
    const same = object("abc");
    for (const i of [0, 1, 2]) (same.styles as Record<number, Record<number, Record<string, unknown>>>)[0][i].underline = true;
    same.initDimensions();
    expect(nativeSpec(same, VIEWPORT).underlines).toHaveLength(1);
  });

  it("reads styles without a size or a fill and skips characters without a box", () => {
    const o = object("ab");
    o.ytaNative.alpha = 0.5;
    Object.assign(o, { opacity: undefined });
    o.set("styles", {});
    o.set({ fill: 5 as never, fontSize: 0 });
    o.initDimensions();
    const bounds = (o as unknown as { __charBounds: unknown[][] }).__charBounds;
    bounds[0].splice(1);
    const spec = nativeSpec(o, VIEWPORT);
    expect(spec.runs[0].glyphs).toHaveLength(1);
    expect(spec.runs[0].color).toEqual({ space: "gray", components: [0] });
    expect(spec.opacity).toBe(1);
    (o as unknown as { __charBounds: unknown[][] }).__charBounds = [];
    expect(nativeSpec(o, VIEWPORT).runs).toEqual([]);
  });

  it("reads specs from serialised objects, skipping what is not native text", async () => {
    expect(await nativeSpecsFromData([{ type: "Rect" }], VIEWPORT)).toEqual([]);
    const native = object("ab") as NativeText;
    const json = (native as unknown as { toObject(props: string[]): Record<string, unknown> }).toObject(["ytaNative"]);
    const specs = await nativeSpecsFromData([json, { type: "Rect", ytaNative: {} }], VIEWPORT);
    expect(specs).toHaveLength(1);
    expect(specs[0].id).toBe("l:0:0");
  });
});

describe("geometry helpers", () => {
  it("maps points to the scene and tests them against quads", () => {
    expect(toScene(VIEWPORT, [[1, 2]])).toEqual([[1, 798]]);
    const quad: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInQuad([5, 5], quad)).toBe(true);
    expect(pointInQuad([15, 5], quad)).toBe(false);
    expect(pointInQuad([10.5, 5], quad, 1)).toBe(true);
    expect(pointInQuad([5, 5], [[0, 0], [0, 0], [10, 0], [10, 10]])).toBe(true);
  });
});
