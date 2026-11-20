// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Matrix } from "./geometry";
import { createNativeText, isNativeData } from "./nativeText";
import type { AnalyzedChar, AnalyzedFont, PageTextAnalysis, TextUnit } from "./pdfText/types";
import { ocrRedactionBoxes, redactionBoxesFor, replaceInObject, replaceOnPage } from "./textReplace";

const VIEWPORT: Matrix = [1, 0, 0, -1, 0, 800];
const BLACK = { space: "gray" as const, components: [0] };

const font: AnalyzedFont = {
  key: "F",
  name: "Prueba",
  families: ["Prueba"],
  bold: false,
  italic: false,
  serif: false,
  monospace: false,
  sample: "0:0",
  glyphs: Object.fromEntries([..."abcdefghijklmnopqrstuvwxyzáé "].map((c, i) => [c, [97 + i, 1, 500]])),
  space: 250,
};

const chars = (text: string): AnalyzedChar[] =>
  [...text].map((c, i) => ({ text: c, font: 0, size: 10, color: BLACK, rise: 0, x0: i * 5, x1: i * 5 + 5 }));

let units = 0;
const unit = (text: string, changes: Partial<TextUnit> = {}): TextUnit => {
  const n = units++;
  return {
    id: `l:${n}`,
    kind: "line",
    lines: [chars(text)],
    joins: [],
    align: "left",
    origin: [100, 700 - n * 20],
    u: [1, 0],
    v: [0, 1],
    hScale: 1,
    width: text.length * 5,
    naturalWidth: text.length * 5,
    leading: 0,
    size: 10,
    erase: [`${n}:0-${text.length - 1}`],
    insertAfter: "end",
    alpha: 1,
    renderMode: 0,
    quads: [[[100, 698 - n * 20], [100 + text.length * 5, 698 - n * 20], [100 + text.length * 5, 708 - n * 20], [100, 708 - n * 20]]],
    editable: true,
    justifyLast: false,
    ...changes,
  };
};

const analysis = (lines: TextUnit[]): PageTextAnalysis => ({ fonts: [font], lines, paragraphs: [], paragraphOf: [] });

describe("replacing in one object", () => {
  it("replaces every match, keeping the style of its first character", () => {
    const object = createNativeText(unit("hola hola"), analysis([]), VIEWPORT);
    expect(replaceInObject(object, "hola", "adiós")).toBe(2);
    expect(object.text).toBe("adiós adiós");
    expect(replaceInObject(object, "nada", "x")).toBe(0);
  });

  it("replaces matches that start or end inside a grapheme", () => {
    const object = createNativeText(unit("cafe"), analysis([]), VIEWPORT);
    object.set("text", "café fin");
    expect(replaceInObject(object, "cafe", "te")).toBe(1);
    expect(object.text.startsWith("te")).toBe(true);
    expect(replaceInObject(object, "", "x")).toBe(0);
  });
});

describe("replacing on a page", () => {
  it("edits the page's lines, skipping text that cannot be edited", async () => {
    const lines = [unit("hola mundo"), unit("hola"), unit("nada"), unit("hola", { editable: false }), unit("x", { lines: [] })];
    const result = await replaceOnPage(analysis(lines), VIEWPORT, undefined, "hola", "adiós");
    expect(result.replaced).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.data?.objects.filter(isNativeData)).toHaveLength(2);
  });

  it("changes text already edited where it is, and leaves its original lines alone", async () => {
    const lines = [unit("hola"), unit("otra")];
    const page = analysis(lines);
    const edited = createNativeText(lines[0], page, VIEWPORT);
    const untouched = createNativeText(lines[1], page, VIEWPORT);
    const data = {
      version: "7",
      objects: [
        (edited as unknown as { toObject(props: string[]): Record<string, unknown> }).toObject(["ytaNative"]),
        (untouched as unknown as { toObject(props: string[]): Record<string, unknown> }).toObject(["ytaNative"]),
        { type: "Rect", width: 5, height: 5, ytaNative: {} },
        { type: "Rect", width: 5, height: 5 },
      ],
    };
    const result = await replaceOnPage(page, VIEWPORT, data, "hola", "chau");
    expect(result.replaced).toBe(1);
    expect(result.data?.objects).toHaveLength(4);
    expect((result.data?.objects[0] as { text: string }).text).toBe("chau");
  });

  it("reports nothing changed when there are no matches", async () => {
    expect(await replaceOnPage(analysis([unit("hola")]), VIEWPORT, undefined, "zzz", "y")).toEqual({ data: null, replaced: 0, skipped: 0 });
  });

  it("replaces in single-line units built from their characters", async () => {
    // A unit whose characters were set after it was made.
    const odd = unit("ab");
    odd.lines = [chars("ab")];
    const result = await replaceOnPage(analysis([odd]), VIEWPORT, undefined, "ab", "cd");
    expect(result.replaced).toBe(1);
  });
});

describe("redaction boxes", () => {
  it("covers matches with boxes, skipping characters without positions and lines without quads", () => {
    const positioned = unit("hola hola");
    positioned.lines[0][6] = { ...positioned.lines[0][6], x0: undefined as never };
    const noQuad = unit("hola", { quads: [] });
    const flat = unit("hola");
    flat.lines[0] = flat.lines[0].map((c) => ({ ...c, x0: 0, x1: 0 }));
    const empty = unit("x", { lines: [] });
    const boxes = redactionBoxesFor(analysis([positioned, noQuad, flat, empty]), VIEWPORT, "hola");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.ytaKind === "redact")).toBe(true);
  });

  it("covers recognised words", () => {
    const quad: [number, number][] = [[0, 0], [40, 0], [40, 10], [0, 10]];
    expect(ocrRedactionBoxes({ languages: "spa", lines: [{ quad, words: [{ text: "secreto", quad }] }] }, VIEWPORT, "secreto")).toHaveLength(1);
    expect(ocrRedactionBoxes(undefined, VIEWPORT, "secreto")).toEqual([]);
  });
});
