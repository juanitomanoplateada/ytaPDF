import { PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFContext, type PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { analyzePage, type FontProgramReader } from "./analyze";
import { FontCache } from "./fonts";
import type { PageTextAnalysis } from "./types";

const encoder = new TextEncoder();

interface FakeProgram {
  numGlyphs: number;
  characterSet?: number[];
  glyphForCodePoint(cp: number): { id: number };
  getGlyph(id: number): { path: { commands: unknown[] }; advanceWidth: number };
}

/** Programs by the text of their (fake) font file. */
const PROGRAMS: Record<string, FakeProgram> = {
  simple: {
    numGlyphs: 6,
    glyphForCodePoint(cp) {
      if (cp === 0x45) throw new Error("tabla dañada");
      // A, B, space, C, D (out of range), F only through the symbol area.
      const ids: Record<number, number> = { 0x41: 1, 0x42: 2, 0x20: 3, 0x43: 4, 0x44: 9, 0xf046: 5 };
      return { id: ids[cp] ?? 0 };
    },
    getGlyph(id) {
      if (id === 2) throw new Error("glifo dañado");
      return { path: { commands: id === 1 || id === 5 ? ["M"] : [] }, advanceWidth: id === 3 ? 250 : 0 };
    },
  },
  cid: {
    numGlyphs: 50,
    // "A" is glyph 10 (CID 1 through the map), "B" glyph 11 (CID 2), "Z" has no glyph,
    // "Q" maps to a glyph no CID uses, and "X" repeats glyph 10.
    characterSet: [0x41, 0x42, 0x5a, 0x51, 0x58, 0x43],
    glyphForCodePoint(cp) {
      if (cp === 0x43) throw new Error("fin de la tabla");
      return { id: ({ 0x41: 10, 0x42: 11, 0x51: 40, 0x58: 10 } as Record<number, number>)[cp] ?? 0 };
    },
    getGlyph: () => ({ path: { commands: ["M"] }, advanceWidth: 500 }),
  },
  identity: {
    numGlyphs: 50,
    characterSet: [0x5a],
    glyphForCodePoint: () => ({ id: 0 }),
    getGlyph: () => ({ path: { commands: ["M"] }, advanceWidth: 500 }),
  },
  plain: {
    numGlyphs: 100,
    glyphForCodePoint: () => ({ id: 1 }),
    getGlyph: () => ({ path: { commands: ["M"] }, advanceWidth: 500 }),
  },
};

const reader: FontProgramReader = {
  create(bytes) {
    const name = new TextDecoder().decode(bytes);
    if (name === "roto") throw new Error("no es una fuente");
    return PROGRAMS[name] as never;
  },
};

const fontFile = (context: PDFContext, name: string, dict: Record<string, unknown> = {}) =>
  context.register(context.flateStream(encoder.encode(name), dict as never));

async function analyze(content: string, fonts: (context: PDFContext, helvetica: PDFRef) => Record<string, unknown>, programReader: FontProgramReader | undefined = reader): Promise<PageTextAnalysis> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const helvetica = (await doc.embedFont(StandardFonts.Helvetica)).ref;
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fonts(doc.context, helvetica) } as never));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
  await doc.flush();
  return analyzePage(page, new FontCache(doc.context), programReader);
}

const glyphTexts = (analysis: PageTextAnalysis, index: number) => Object.keys(analysis.fonts[index].glyphs).sort();

describe("fonts of editable text", () => {
  it("offers only the glyphs an embedded subset really has", async () => {
    const analysis = await analyze("BT /S 10 Tf 50 700 Td (AA) Tj ET", (context) => ({
      S: context.obj({
        Type: "Font",
        Subtype: "TrueType",
        BaseFont: "ABCDEF+Prueba",
        Encoding: "WinAnsiEncoding",
        FirstChar: 32,
        Widths: Array.from({ length: 60 }, () => 500),
        FontDescriptor: { Flags: 32, FontFile2: fontFile(context, "simple") },
      }),
    }));
    // A is on the page; F is reached through the symbol area; the space has width;
    // B (broken glyph), C (empty), D (out of range) and E (broken table) are left out.
    expect(glyphTexts(analysis, 0)).toEqual([" ", "A", "F"]);
  });

  it("assumes full programs have every glyph and reads nothing from the others", async () => {
    // These fonts list no widths, so each "A" is moved along by hand.
    const analysis = await analyze("BT /Full 10 Tf 50 700 Td (A) Tj 8 0 Td /Cff 10 Tf (A) Tj 8 0 Td /Broken 10 Tf (A) Tj ET", (context) => {
      const simple = (name: string, descriptor: Record<string, unknown>) =>
        context.obj({ Type: "Font", Subtype: "TrueType", BaseFont: name, Encoding: "WinAnsiEncoding", FontDescriptor: { Flags: 32, ...descriptor } });
      return {
        Full: simple("Completa", { FontFile3: fontFile(context, "plain", { Subtype: "OpenType" }) }),
        Cff: simple("Compacta", { FontFile3: fontFile(context, "plain", { Subtype: "Type1C" }) }),
        Broken: simple("Rota", { FontFile2: fontFile(context, "roto") }),
      };
    });
    expect(analysis.fonts).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(glyphTexts(analysis, i)).toContain("z");
  });

  it("reads programs that cannot be decoded as having none", async () => {
    const analysis = await analyze("BT /Raw 10 Tf 50 700 Td (A) Tj ET", (context) => ({
      Raw: context.obj({
        Type: "Font",
        Subtype: "TrueType",
        BaseFont: "ABCDEF+Cruda",
        Encoding: "WinAnsiEncoding",
        FontDescriptor: { Flags: 32, FontFile2: context.register(PDFRawStream.of(context.obj({ Filter: "JBIG2Decode" }), Uint8Array.of(1))) },
      }),
    }));
    // A subset without a readable program offers what is on the page only.
    expect(glyphTexts(analysis, 0)).toEqual([" ", "A"]);
  });

  it("recovers the text of composite fonts from their program and maps CIDs to glyphs", async () => {
    const analysis = await analyze("BT /C 10 Tf 50 700 Td <00010002> Tj /I 10 Tf <005A> Tj ET", (context) => {
      const descendant = (program: string, map: unknown) => [
        { Type: "Font", Subtype: "CIDFontType2", BaseFont: "ABCDEF+Cid", CIDToGIDMap: map, FontDescriptor: { Flags: 32, FontFile2: fontFile(context, program) } },
      ];
      // CID 1 → glyph 10, CID 2 → glyph 11, CID 3 → glyph 12.
      const map = context.register(context.stream(Uint8Array.of(0, 0, 0, 10, 0, 11, 0, 12)));
      return {
        C: context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "ABCDEF+Cid", Encoding: "Identity-H", DescendantFonts: descendant("cid", map) }),
        I: context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "ABCDEF+Ident", Encoding: "Identity-H", DescendantFonts: descendant("identity", "Identity") }),
      };
    });
    const line = analysis.lines[0];
    expect(line.lines[0].map((c) => c.text).join("")).toBe("AB�");
    expect(line.editable).toBe(false);
    expect(glyphTexts(analysis, 0)).toEqual([" ", "A", "B"]);
  });

  it("finds glyphs of composite fonts whose CIDs map through an identity or nothing", async () => {
    const analysis = await analyze("BT /I 10 Tf 50 700 Td <0041> Tj /N 10 Tf <0041> Tj ET", (context) => {
      const toUnicode = context.register(
        context.flateStream(encoder.encode("1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0041> <0041> <0042> <0042> endbfchar")),
      );
      const font = (map: unknown) =>
        context.obj({
          Type: "Font",
          Subtype: "Type0",
          BaseFont: "ABCDEF+Uni",
          Encoding: "Identity-H",
          ToUnicode: toUnicode,
          DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", CIDToGIDMap: map, FontDescriptor: { Flags: 32, FontFile2: fontFile(context, "plain") } }],
        } as never);
      return { I: font("Identity"), N: font(7) };
    });
    // B is not on the page: identity maps it to glyph 66, which "plain" has;
    // without a map its glyph is unknown, so the subset is trusted not to have it.
    expect(glyphTexts(analysis, 0)).toEqual([" ", "A", "B"]);
    expect(glyphTexts(analysis, 1)).toEqual([" ", "A"]);
  });

  it("never offers more than the page for composite or Type 3 fonts without a program", async () => {
    const analysis = await analyze("BT /C 10 Tf 50 700 Td <0041> Tj 10 0 Td /T 10 Tf (A) Tj 8 0 Td /E 10 Tf (A) Tj ET", (context) => {
      const toUnicode = context.register(
        context.flateStream(encoder.encode("1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0041> <0041> <0042> <0042> endbfchar")),
      );
      return {
        C: context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "Cid", Encoding: "Identity-H", ToUnicode: toUnicode, DescendantFonts: [{ Subtype: "CIDFontType0" }] } as never),
        T: context.obj({ Type: "Font", Subtype: "Type3", FontMatrix: [0.001, 0, 0, 0.001, 0, 0], Encoding: { Differences: [65, "A", "B"] } }),
        E: context.obj({
          Type: "Font",
          Subtype: "Type3",
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          Encoding: { Differences: [65, "A", "B"] },
          FontDescriptor: { FontFile: fontFile(context, "plain") },
        }),
      };
    });
    for (let i = 0; i < 3; i++) expect(glyphTexts(analysis, i)).toEqual([" ", "A"]);
  });

  it("keeps the first code seen for each text and skips codes without text", async () => {
    const analysis = await analyze("BT /D 10 Tf 50 700 Td (AB\\001) Tj ET", (context) => ({
      D: context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: { Differences: [66, "A", 2, "space"] } }),
    }));
    expect(analysis.fonts[0].glyphs.A[0]).toBe(65);
    // Codes not on the page are taken in order: code 2 is the first space.
    expect(analysis.fonts[0].glyphs[" "][0]).toBe(2);
  });

  it("works without a program reader", async () => {
    const analysis = await analyze("BT /C 10 Tf 50 700 Td <0001> Tj ET", (context) => ({
      C: context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "Cid", Encoding: "Identity-H", DescendantFonts: [{ Subtype: "CIDFontType2", FontDescriptor: { FontFile2: fontFile(context, "cid") } }] }),
    }), undefined);
    expect(analysis.lines[0].editable).toBe(false);
  });
});

describe("editable units", () => {
  it("keeps full lines of justified text justified when edited alone", async () => {
    const analysis = await analyze(
      "BT /F1 10 Tf 8 Tw 50 700 Td (aaaa aaaa) Tj 0 -12 Td (aaaa aaaa) Tj 0 -12 Td (bb) Tj ET",
      (_context, helvetica) => ({ F1: helvetica }),
    );
    expect(analysis.paragraphs).toHaveLength(1);
    expect(analysis.paragraphs[0]).toMatchObject({ align: "justify", justifyLast: false });
    expect(analysis.lines.map((l) => l.align)).toEqual(["justify", "justify", "left"]);
    expect(analysis.paragraphOf).toEqual([0, 0, 0]);
  });

  it("marks the last line as justified when it reaches the edge", async () => {
    const analysis = await analyze(
      "BT /F1 10 Tf 8 Tw 50 700 Td (aaaa aaaa) Tj 0 -12 Td (aaaa aaaa) Tj 0 -12 Td (aaaa aaaa) Tj ET",
      (_context, helvetica) => ({ F1: helvetica }),
    );
    expect(analysis.paragraphs[0].justifyLast).toBe(true);
  });

  it("inserts a paragraph's replacement after its first text object", async () => {
    const analysis = await analyze("BT /F1 10 Tf 50 700 Td (Primera linea) Tj ET BT /F1 10 Tf 50 688 Td (segunda linea) Tj", (_context, helvetica) => ({ F1: helvetica }));
    expect(analysis.paragraphs[0].insertAfter).toBe("4");
    expect(analysis.lines[1].insertAfter).toBe("end");
  });

  it("explains why text on pages with unreadable content cannot be edited", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const helvetica = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const { context } = doc;
    page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: helvetica } } as never));
    const text = context.register(context.flateStream(encoder.encode("BT /F1 10 Tf 50 700 Td (Hola) Tj ET")));
    const broken = context.register(PDFRawStream.of(context.obj({ Filter: "JBIG2Decode" }), Uint8Array.of(1)));
    page.node.set(PDFName.of("Contents"), context.obj([text, broken]));
    await doc.flush();
    const [line] = analyzePage(page, new FontCache(context)).lines;
    expect(line.reason).toBe("Esta página usa una compresión que no se puede modificar.");
  });
});
