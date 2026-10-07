import type { PDFPage } from "@cantoo/pdf-lib";
import type { FontCache, PdfFont } from "./fonts";
import { interpretPage, type Glyph } from "./interpreter";
import { buildLines, buildParagraphs, spaceEm, type LayoutLine, type LayoutParagraph } from "./layout";
import { streamBytes } from "./pdfObjects";
import { compressRanges } from "./ranges";
import type { AnalyzedChar, AnalyzedFont, PageTextAnalysis, Point, TextUnit } from "./types";

/** The part of fontkit used to look inside embedded TrueType/OpenType programs. */
export interface FontProgramReader {
  create(bytes: Uint8Array): FontProgram;
}

interface FontProgram {
  numGlyphs: number;
  characterSet?: number[];
  getGlyph(id: number): { path: { commands: unknown[] }; advanceWidth: number };
  glyphForCodePoint(codePoint: number): { id: number };
}

/** Unicode ranges offered for fonts that are not subsets (they may hold thousands of glyphs). */
const USEFUL_RANGES: [number, number][] = [
  [0x20, 0x24f],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2100, 0x214f],
];

const isUseful = (text: string) => {
  const cp = text.codePointAt(0) ?? 0;
  return USEFUL_RANGES.some(([from, to]) => cp >= from && cp <= to);
};

/**
 * Finds the text of a page that can be edited: lines and paragraphs with the
 * fonts they use and what those fonts can draw again.
 */
export function analyzePage(page: PDFPage, fonts: FontCache, reader?: FontProgramReader): PageTextAnalysis {
  const content = interpretPage(page, fonts);
  const programs = new ProgramCache(reader);
  recoverUnicode(content.glyphs, programs);

  const observed = new Map<PdfFont, Set<number>>();
  for (const glyph of content.glyphs) {
    let codes = observed.get(glyph.font);
    if (!codes) observed.set(glyph.font, (codes = new Set()));
    codes.add(glyph.code);
  }

  const table: AnalyzedFont[] = [];
  const indexOf = new Map<PdfFont, number>();
  const fontIndex = (glyph: Glyph): number => {
    let index = indexOf.get(glyph.font);
    if (index === undefined) {
      index = table.length;
      table.push(describeFont(glyph, observed.get(glyph.font) ?? new Set(), programs));
      indexOf.set(glyph.font, index);
    }
    return index;
  };

  const lines = buildLines(content.glyphs);
  const problem = (line: LayoutLine): string | undefined => {
    if (!content.complete) return "Esta página usa una compresión que no se puede modificar.";
    if (line.glyphs.some((g) => g.glyph.unicode === undefined || !g.glyph.font.decodable)) {
      return "La fuente de este texto no indica qué caracteres dibuja, así que no se puede leer para editarlo.";
    }
    return undefined;
  };

  const paragraphs = buildParagraphs(lines, (line) => problem(line) === undefined);
  const lineUnits = lines.map((line) => {
    const paragraph = paragraphs.find((p) => p.lines.includes(line));
    return toUnit("line", lineParagraph(line, paragraph), fontIndex, problem(line));
  });
  const paragraphUnits: TextUnit[] = [];
  const paragraphOf = lines.map(() => -1);
  for (const paragraph of paragraphs) {
    if (paragraph.lines.length < 2) continue;
    const unit = toUnit("paragraph", paragraph, fontIndex, undefined);
    for (const line of paragraph.lines) paragraphOf[lines.indexOf(line)] = paragraphUnits.length;
    paragraphUnits.push(unit);
  }
  return { fonts: table, lines: lineUnits, paragraphs: paragraphUnits, paragraphOf };
}

/** A line edited on its own keeps its width if it was a full line of justified text. */
function lineParagraph(line: LayoutLine, paragraph: LayoutParagraph | undefined): LayoutParagraph {
  const index = paragraph?.lines.indexOf(line) ?? -1;
  const full =
    paragraph !== undefined &&
    paragraph.align === "justify" &&
    index >= 0 &&
    index < paragraph.lines.length - 1 &&
    paragraph.joins[index] !== "\n";
  return {
    lines: [line],
    joins: [],
    align: full ? "justify" : "left",
    left: line.start,
    right: full ? paragraph.right : line.end,
    leading: 0,
  };
}

function toUnit(
  kind: TextUnit["kind"],
  paragraph: LayoutParagraph,
  fontIndex: (glyph: Glyph) => number,
  reason: string | undefined,
): TextUnit {
  const { lines } = paragraph;
  const first = lines[0];
  const firstGlyph = first.chars.find((c) => !c.inferred)!.glyph;
  const u = first.u;
  const n = first.n;
  const at = (along: number, perp: number): Point => [along * u[0] + perp * n[0], along * u[1] + perp * n[1]];

  const chars = lines.map((line) =>
    line.chars.map((c): AnalyzedChar => {
      const g = c.glyph;
      const scale = g.glyph.size !== 0 ? g.size / g.glyph.size : 1;
      return {
        text: c.text,
        font: fontIndex(g.glyph),
        size: g.size,
        color: g.glyph.color,
        rise: c.inferred ? 0 : g.glyph.rise * scale,
      };
    }),
  );

  const naturalWidth = Math.max(
    ...lines.map((line) =>
      line.chars.reduce((sum, c) => {
        const g = c.glyph;
        const em = c.inferred ? spaceEm(g.glyph.font) : g.glyph.font.width(g.glyph.code) * g.glyph.font.scale;
        return sum + em * g.size;
      }, 0),
    ),
  );

  const glyphs = lines.flatMap((line) => line.glyphs.map((g) => g.glyph));
  const insertAfter = glyphs
    .map((g) => g.insertAfter)
    .reduce((best, value) => (value !== "end" && (best === "end" || Number(value) < Number(best)) ? value : best), "end");

  const quads = lines.map((line) => {
    const ascent = Math.max(...line.glyphs.map((g) => g.glyph.font.ascent));
    const descent = Math.min(...line.glyphs.map((g) => g.glyph.font.descent));
    const bottom = line.perp + descent * line.size;
    const top = line.perp + ascent * line.size;
    return [at(line.start, bottom), at(line.end, bottom), at(line.end, top), at(line.start, top)];
  });

  const last = lines.at(-1)!;
  return {
    id: `${kind === "line" ? "l" : "p"}:${firstGlyph.glyph.key}`,
    kind,
    lines: chars,
    joins: paragraph.joins,
    align: paragraph.align,
    origin: at(paragraph.left, first.perp),
    u,
    v: firstGlyph.v,
    hScale: firstGlyph.hScale,
    width: paragraph.right - paragraph.left,
    naturalWidth,
    leading: paragraph.leading,
    size: Math.max(...lines.map((l) => l.size)),
    erase: compressRanges(glyphs),
    insertAfter,
    alpha: firstGlyph.glyph.alpha,
    renderMode: firstGlyph.glyph.renderMode,
    quads,
    editable: reason === undefined,
    reason,
    justifyLast: paragraph.align === "justify" && Math.abs(last.end - paragraph.right) < 0.5 * last.size,
  };
}

// ── Fonts ──────────────────────────────────────────────────────────────────

class ProgramCache {
  readonly #programs = new Map<PdfFont, FontProgram | null>();
  constructor(private readonly reader: FontProgramReader | undefined) {}

  get(font: PdfFont): FontProgram | undefined {
    if (!this.reader || !font.program || (font.program.kind !== "TrueType" && font.program.kind !== "OpenType")) return undefined;
    let program = this.#programs.get(font);
    if (program === undefined) {
      const bytes = streamBytes(font.program.stream);
      try {
        program = bytes ? this.reader.create(bytes) : null;
      } catch {
        program = null;
      }
      this.#programs.set(font, program);
    }
    return program ?? undefined;
  }
}

/** Glyph index of a code in a TrueType-based font, when it can be worked out. */
function glyphIndex(font: PdfFont, program: FontProgram, code: number, text: string | undefined): number | undefined {
  if (font.composite) {
    const cid = font.cid(code);
    if (font.cidToGid === "identity") return cid;
    return font.cidToGid?.[cid];
  }
  const candidates = [text?.codePointAt(0), code, 0xf000 + code];
  for (const cp of candidates) {
    if (cp === undefined) continue;
    try {
      const id = program.glyphForCodePoint(cp).id;
      if (id > 0) return id;
    } catch {
      return undefined;
    }
  }
  return 0;
}

/** Whether the embedded program really has an outline for a code (subsets drop unused ones). */
function hasGlyph(font: PdfFont, program: FontProgram, code: number, text: string | undefined): boolean | undefined {
  const id = glyphIndex(font, program, code, text);
  if (id === undefined) return undefined;
  if (id <= 0 || id >= program.numGlyphs) return false;
  try {
    const glyph = program.getGlyph(id);
    if (glyph.path.commands.length > 0) return true;
    return text !== undefined && /^\s$/u.test(text) && glyph.advanceWidth > 0;
  } catch {
    return undefined;
  }
}

/** Fonts without a ToUnicode map: the program's own character map tells the text. */
function recoverUnicode(glyphs: Glyph[], programs: ProgramCache): void {
  const done = new Set<PdfFont>();
  for (const glyph of glyphs) {
    if (glyph.unicode !== undefined || done.has(glyph.font)) continue;
    done.add(glyph.font);
    const font = glyph.font;
    const program = programs.get(font);
    if (!program || !font.composite || !program.characterSet) continue;
    const gidToCid = new Map<number, number>();
    if (font.cidToGid instanceof Uint16Array) font.cidToGid.forEach((gid, cid) => gidToCid.set(gid, cid));
    const map = new Map<number, string>();
    for (const cp of program.characterSet) {
      try {
        const gid = program.glyphForCodePoint(cp).id;
        if (gid <= 0) continue;
        const cid = font.cidToGid === "identity" ? gid : gidToCid.get(gid);
        // Identity-H: the code is the CID.
        if (cid !== undefined && !map.has(cid)) map.set(cid, String.fromCodePoint(cp));
      } catch {
        break;
      }
    }
    if (map.size > 0) font.setProgramUnicode(map);
  }
  for (const glyph of glyphs) glyph.unicode ??= glyph.font.unicode(glyph.code);
}

function describeFont(sample: Glyph, observed: Set<number>, programs: ProgramCache): AnalyzedFont {
  const font = sample.font;
  const program = programs.get(font);
  const glyphs: AnalyzedFont["glyphs"] = {};
  const fromObserved = new Set<string>();

  for (const code of new Set([...observed, ...font.mappedCodes()])) {
    const raw = font.unicode(code);
    if (!raw || /^[\u0000-\u001f]+$/.test(raw)) continue;
    const text = raw.normalize("NFC");
    const seen = observed.has(code);
    if (!seen) {
      if (fromObserved.has(text) || !isUseful(text)) continue;
      if (!available(font, program, code, text)) continue;
    }
    if (glyphs[text] && (fromObserved.has(text) || !seen)) continue;
    glyphs[text] = [code, font.codeLength(code), font.width(code) * font.scale * 1000];
    if (seen) fromObserved.add(text);
  }
  const space = spaceEm(font) * 1000;
  if (!glyphs[" "]) glyphs[" "] = [-1, 0, space];

  return {
    key: font.id,
    name: font.name,
    families: font.cssFamilies(),
    bold: font.bold,
    italic: font.italic,
    serif: font.serif,
    monospace: font.monospace,
    sample: sample.key,
    glyphs,
    space,
  };
}

/** Whether a code that does not appear on the page can still be drawn with the font. */
function available(font: PdfFont, program: FontProgram | undefined, code: number, text: string): boolean {
  if (!font.embedded) return !font.composite && font.subtype !== "Type3";
  if (font.subtype === "Type3") return false;
  if (program) {
    const result = hasGlyph(font, program, code, text);
    if (result !== undefined) return result;
  }
  // A full (not subset) program has every glyph its encoding names.
  return !font.subset;
}
