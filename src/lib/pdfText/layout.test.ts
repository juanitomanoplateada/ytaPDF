import { describe, expect, it } from "vitest";
import type { PdfFont } from "./fonts";
import type { Glyph } from "./interpreter";
import { buildLines, buildParagraphs, naturalWidth, spaceEm, type LayoutLine } from "./layout";

/**
 * Synthetic glyphs: every character is half an em wide (500 units at
 * 1/1000), so at size 10 a character takes 5 units and a word is easy to
 * place by hand.
 */
function fakeFont(options: { space?: number; spaceText?: string; composite?: boolean; mapped?: Record<number, string> } = {}): PdfFont {
  const mapped = options.mapped ?? {};
  return {
    scale: 0.001,
    composite: options.composite ?? false,
    width: (code: number) => (code === 32 ? (options.space ?? 250) : 500),
    unicode: (code: number) => (code === 32 ? (options.spaceText ?? " ") : mapped[code]),
    mappedCodes: () => Object.keys(mapped).map(Number),
  } as unknown as PdfFont;
}

const FONT = fakeFont();
let op = 0;

function glyph(text: string | undefined, x: number, y: number, changes: Partial<Glyph> = {}): Glyph {
  op++;
  const size = changes.size ?? 10;
  return {
    key: `${op}:0`,
    path: "",
    op,
    index: 0,
    code: text === " " ? 32 : (text?.codePointAt(0) ?? 0),
    length: 1,
    unicode: text,
    font: FONT,
    fontObject: undefined as never,
    size,
    hScale: 1,
    charSpacing: 0,
    wordSpacing: 0,
    rise: 0,
    renderMode: 0,
    textMatrix: [1, 0, 0, 1, x, y],
    ctm: [1, 0, 0, 1, 0, 0],
    advance: 500,
    width: 500,
    color: { space: "gray", components: [0] },
    alpha: 1,
    insertAfter: "end",
    textObject: 0,
    vertical: false,
    ...changes,
  };
}

/** A run of characters from `x`, each after the previous one (spaces are a quarter em). */
function word(text: string, x: number, y: number, changes: Partial<Glyph> = {}): Glyph[] {
  const size = changes.size ?? 10;
  let pen = x;
  return [...text].map((char) => {
    const placed = glyph(char, pen, y, changes);
    pen += size * (char === " " ? 0.25 : 0.5);
    return placed;
  });
}

const lineText = (line: LayoutLine) => line.chars.map((c) => c.text).join("");
const always = () => true;

describe("space widths", () => {
  it("uses the font's own space, or one it maps elsewhere, or a typical width", () => {
    expect(spaceEm(fakeFont({ space: 300 }))).toBeCloseTo(0.3);
    expect(spaceEm(fakeFont({ space: 0, mapped: { 3: " " } }))).toBeCloseTo(0.5);
    expect(spaceEm(fakeFont({ spaceText: "x", mapped: { 3: "a" } }))).toBe(0.25);
    expect(spaceEm(fakeFont({ composite: true }))).toBe(0.25);
    expect(spaceEm(fakeFont({ space: 2000 }))).toBe(0.25);
  });
});

describe("lines", () => {
  it("ignores glyphs that cannot be placed or read", () => {
    const hidden = [
      glyph("a", 0, 0, { size: 0 }),
      glyph("b", Number.NaN, 0),
      glyph("c", 0, 0, { size: 0.4 }),
      glyph("d", 0, 0, { vertical: true }),
      glyph("e", 0, 0, { renderMode: 3 }),
    ];
    expect(buildLines(hidden)).toEqual([]);
    expect(buildLines([])).toEqual([]);
    expect(buildLines(word("   ", 0, 0))).toEqual([]);
  });

  it("infers spaces in gaps and keeps drawn ones once, but not at either end", () => {
    const glyphs = [
      glyph(" ", -5, 0),
      ...word("Hola", 0, 0),
      glyph(" ", 20, 0),
      glyph(" ", 22, 0),
      ...word("mun", 25, 0),
      ...word("do", 45, 0),
      glyph("\u0001", 55, 0),
      glyph(undefined, 56, 0),
      glyph(" ", 61, 0),
    ];
    const [line] = buildLines(glyphs);
    expect(lineText(line)).toBe("Hola mun do�");
    expect(line.chars.filter((c) => c.inferred)).toHaveLength(1);
    // Eleven glyphs half an em wide, one drawn and one inferred space.
    expect(naturalWidth(line)).toBeCloseTo(11 * 5 + 2 * 2.5 - 5);
  });

  it("treats glyphs drawn twice in place as fake bold, but not when they are shifted across", () => {
    const bold = buildLines([...word("ab", 0, 0), ...word("ab", 0.5, 0)]);
    expect(bold).toHaveLength(1);
    expect(bold[0].glyphs.filter((g) => g.duplicate)).toHaveLength(2);
    expect(lineText(bold[0])).toBe("ab");

    // The same glyph listed twice is not its own twin.
    const shared = glyph("a", 0, 0);
    expect(buildLines([shared, shared])[0].glyphs.map((g) => g.duplicate)).toEqual([false, false]);

    const shifted = buildLines([...word("ab", 0, 0), ...word("ab", 0, 2)]);
    expect(shifted[0].glyphs.filter((g) => g.duplicate)).toHaveLength(0);

    // A third copy further along is compared with the first one only.
    const smeared = buildLines([glyph("a", 0, 0), glyph("a", 1.4, 0), glyph("a", 2.8, 0)]);
    expect(smeared[0].glyphs.map((g) => g.duplicate)).toEqual([false, true, false]);
  });

  it("orders glyphs drawn at the same place by operation and index", () => {
    const first = glyph("a", 0, 0, { op: 900, index: 1 });
    const second = glyph("b", 0, 0, { op: 900, index: 0 });
    const third = glyph("c", 0, 0, { op: 800, index: 5 });
    const [line] = buildLines([first, second, third]);
    expect(line.glyphs.map((g) => g.glyph.unicode)).toEqual(["c", "b", "a"]);
  });

  it("splits text written over other text and text in other directions", () => {
    const lines = buildLines([...word("abc", 0, 0), ...word("xyz", 0, 0), ...word("rot", 100, 0, { textMatrix: [0, 1, -1, 0, 100, 0] })]);
    expect(lines.map(lineText)).toEqual(["abc", "xyz", "rot"]);
  });

  it("joins pieces of a line drawn out of order", () => {
    const lines = buildLines([...word("mundo", 30, 0), ...word("hola", 0, 50), ...word("Hola", 0, 0)]);
    expect(lines.map(lineText)).toEqual(["Hola mundo", "hola"]);
  });

  it("measures by the size most glyphs share", () => {
    const [line] = buildLines([glyph("a", 0, 0, { size: 12 }), glyph("b", 6, 0), glyph("c", 11, 0)]);
    expect(line.size).toBe(10);
  });
});

/** Lines at the given baselines (y) and starts (x), with their text. */
const linesOf = (rows: [string, number, number][], changes: Partial<Glyph> = {}) =>
  buildLines(rows.flatMap(([text, x, y]) => word(text, x, y, changes)));

describe("paragraphs", () => {
  it("joins ragged left-aligned lines, breaking after short ones", () => {
    const lines = linesOf([
      ["aaaa aaaa aaaa", 0, 100],
      ["bbbb", 0, 88],
      ["cccc cccc cccc", 0, 76],
      ["dd", 0, 64],
    ]);
    const [paragraph] = buildParagraphs(lines, always);
    expect(paragraph.align).toBe("left");
    expect(paragraph.joins).toEqual([" ", "\n", " "]);
    expect(paragraph.leading).toBe(12);
  });

  it("recognises justified text by its stretched spaces", () => {
    const stretched = [...word("aaa", 0, 100), glyph(" ", 15, 100), ...word("aaa", 30, 100)];
    const lines = buildLines([...stretched, ...word("bbbbbbbbb", 0, 88), ...word("cc", 0, 76), ...word("ddddddddd", 0, 64), ...word("e", 0, 52)]);
    const [paragraph] = buildParagraphs(lines, always);
    expect(paragraph.align).toBe("justify");
    expect(paragraph.joins).toEqual([" ", " ", "\n", " "]);
  });

  it("keeps lines that only reach the right edge unstretched as ragged", () => {
    const lines = linesOf([
      ["aaaaaaaaaaaaaa", 0, 100],
      ["bbbb", 0, 88],
    ]);
    expect(buildParagraphs(lines, always)[0].align).toBe("left");
    const shortFirst = linesOf([
      ["aa", 0, 100],
      ["bbbbbbbbbbbbbb", 0, 88],
      ["cc", 0, 76],
    ]);
    expect(buildParagraphs(shortFirst, always)[0].align).toBe("left");
  });

  it("recognises right-aligned and centred blocks", () => {
    const right = linesOf([
      ["aaaa", 80, 100],
      ["aaaaaaaa", 60, 88],
      ["aa", 90, 76],
    ]);
    expect(buildParagraphs(right, always).map((p) => p.align)).toEqual(["right"]);
    const centred = linesOf([
      ["aaaa", 40, 100],
      ["aaaaaaaa", 30, 88],
      ["aa", 45, 76],
    ]);
    const [paragraph] = buildParagraphs(centred, always);
    expect(paragraph.align).toBe("center");
    expect(paragraph.joins).toEqual([" ", " "]);
  });

  it("leaves lines without a common alignment on their own", () => {
    const lines = linesOf([
      ["aaaaaaaaaaaaaaaaaaaa", 0, 100],
      ["bbbbbbbbbbbb", 0, 88],
      ["cccc", 20, 76],
    ]);
    expect(buildParagraphs(lines, always).map((p) => p.lines.length)).toEqual([1, 1, 1]);
  });

  it("accepts an indented first line", () => {
    const lines = linesOf([
      ["aaaaaaaaaaaaaa", 20, 100],
      ["bbbbbbbb", 0, 88],
    ]);
    expect(buildParagraphs(lines, always).map((p) => p.lines.length)).toEqual([2]);
  });

  it("does not join lines that differ in size, spacing, position or alignment", () => {
    const sizes = buildLines([...word("aaaa", 0, 100), ...word("bbbb", 0, 86, { size: 14 })]);
    expect(buildParagraphs(sizes, always)).toHaveLength(2);
    const far = linesOf([
      ["aaaa", 0, 100],
      ["bbbb", 0, 70],
    ]);
    expect(buildParagraphs(far, always)).toHaveLength(2);
    const uneven = linesOf([
      ["aaaa", 0, 100],
      ["bbbb", 0, 88],
      ["cccc", 0, 68],
    ]);
    expect(buildParagraphs(uneven, always).map((p) => p.lines.length)).toEqual([2, 1]);
    const apart = linesOf([
      ["aaaa", 0, 100],
      ["bbbb", 200, 88],
    ]);
    expect(buildParagraphs(apart, always)).toHaveLength(2);
    const unaligned = linesOf([
      ["aaaaaaaaaaaaaaaaaaaa", 0, 100],
      ["bbbbbb", 10, 88],
    ]);
    expect(buildParagraphs(unaligned, always)).toHaveLength(2);
    const turned = buildLines([...word("aaaa", 0, 100), ...word("bbbb", 0, 88, { textMatrix: [0, 1, -1, 0, 0, 88] })]);
    expect(buildParagraphs(turned, always)).toHaveLength(2);
  });

  it("keeps lines that cannot be joined apart, in either position", () => {
    const lines = linesOf([
      ["Xaaa", 0, 100],
      ["bbbb", 0, 88],
      ["Xccc", 0, 76],
    ]);
    const canJoin = (line: LayoutLine) => !lineText(line).startsWith("X");
    expect(buildParagraphs(lines, canJoin).map((p) => p.lines.length)).toEqual([1, 1, 1]);
  });

  it("keeps hyphenated breaks and copes with lines that have no characters", () => {
    const hyphen = linesOf([
      ["aaaa aaaa-", 0, 100],
      ["bbbb", 0, 88],
    ]);
    expect(buildParagraphs(hyphen, always)[0].joins).toEqual(["\n"]);
    const control = buildLines([...word("aaaa", 0, 100), ...word("\u0001\u0001\u0001\u0001", 0, 88), ...word("cccc", 0, 76)]);
    expect(buildParagraphs(control, always)[0].joins).toEqual([" ", " "]);
  });

  it("orders lines of different columns at the same height from left to right", () => {
    const lines = linesOf([
      ["derecha", 300, 100],
      ["izquierda", 0, 100],
    ]);
    expect(buildParagraphs(lines, always).map((p) => lineText(p.lines[0]))).toEqual(["izquierda", "derecha"]);
  });
});
