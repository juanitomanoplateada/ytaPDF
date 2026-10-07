import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@cantoo/fontkit";
import { PDFDocument, PDFName, StandardFonts, type PDFPage } from "@cantoo/pdf-lib";
import { Encodings, Font as StandardFontMetrics } from "@cantoo/pdf-lib/standard-fonts";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzePage, type FontProgramReader } from "./analyze";
import { applyNativeSpecs, type ApplyResources } from "./apply";
import { FontCache } from "./fonts";
import { appendUpdate, normalizedBase } from "./incremental";
import { TextDocument } from "./textDocument";
import { baselineMatrix, interpretPage } from "./interpreter";
import { parseContent } from "./lexer";
import type { NativeSpec, PageTextAnalysis, RunGlyph, TextUnit } from "./types";

const require = createRequire(import.meta.url);
const NOTO_SANS = new Uint8Array(
  readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")),
);
const reader = fontkit as unknown as FontProgramReader;

const encoder = new TextEncoder();

/** A one-page PDF whose content stream is `content`, with Helvetica as /F1 and Times-Bold as /F2. */
async function pdfWith(content: string | null, extra?: (doc: PDFDocument, page: PDFPage) => Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const timesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const fonts = doc.context.obj({ F1: helvetica.ref, F2: timesBold.ref });
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fonts }));
  await extra?.(doc, page);
  if (content !== null) {
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
  }
  return doc.save();
}

async function analyze(bytes: Uint8Array): Promise<{ doc: PDFDocument; analysis: PageTextAnalysis }> {
  const doc = await PDFDocument.load(bytes);
  return { doc, analysis: analyzePage(doc.getPage(0), new FontCache(doc.context), reader) };
}

interface Item {
  str: string;
  x: number;
  y: number;
  fontName: string;
}

async function textItems(bytes: Uint8Array): Promise<Item[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  return items
    .filter((item) => "str" in item && item.str.trim() !== "")
    .map((item) => {
      const i = item as { str: string; transform: number[]; fontName: string };
      return { str: i.str, x: i.transform[4], y: i.transform[5], fontName: i.fontName };
    });
}

/** Where each glyph of the page starts, read with the interpreter. */
async function glyphStarts(bytes: Uint8Array): Promise<{ text: string; x: number; y: number }[]> {
  const doc = await PDFDocument.load(bytes);
  return interpretPage(doc.getPage(0), new FontCache(doc.context)).glyphs.map((g) => {
    const m = baselineMatrix(g);
    return { text: g.unicode ?? "", x: m[4], y: m[5] };
  });
}

const unitText = (unit: TextUnit) =>
  unit.lines.map((line, i) => line.map((c) => c.text).join("") + (unit.joins[i] ?? "")).join("");

function findLine(analysis: PageTextAnalysis, text: string): TextUnit {
  const unit = analysis.lines.find((line) => unitText(line).includes(text));
  if (!unit) throw new Error(`No se encontró la línea «${text}»: ${analysis.lines.map(unitText).join(" | ")}`);
  return unit;
}

const fallbackOnly: ApplyResources = {
  fallbackFont: async () => {
    throw new Error("Esta prueba no usa fuentes de sustitución");
  },
};

/** A spec that erases `unit` and writes `text` with the unit's own font, from its origin. */
function rewriteWithOriginal(analysis: PageTextAnalysis, unit: TextUnit, text: string): NativeSpec {
  const fontIndex = unit.lines[0][0].font;
  const font = analysis.fonts[fontIndex];
  const size = unit.lines[0][0].size;
  const glyphs: RunGlyph[] = [];
  let x = 0;
  for (const char of text) {
    const entry = font.glyphs[char];
    if (!entry) throw new Error(`La fuente no tiene «${char}»`);
    glyphs.push({ text: char, code: entry[0], length: entry[1], width: entry[2], x, y: 0 });
    x += (entry[2] / 1000) * size;
  }
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

async function apply(doc: PDFDocument, specs: NativeSpec[]): Promise<Uint8Array> {
  const report = await applyNativeSpecs(doc.getPage(0), specs, new FontCache(doc.context), fallbackOnly);
  expect(report.failed).toEqual([]);
  return doc.save();
}

describe("parseContent", () => {
  it("keeps the byte range of each operation and skips inline image data", () => {
    const source = "BT /F1 12 Tf (a\\)b(c)) Tj [<0041> -20 (d)] TJ ET\nBI /W 1 /H 1 ID \u0000ÿEI Q";
    const bytes = Uint8Array.from(source, (c) => c.charCodeAt(0));
    const ops = parseContent(bytes);
    expect(ops.map((o) => o.op)).toEqual(["BT", "Tf", "Tj", "TJ", "ET", "BI", "Q"]);
    const tj = ops[2];
    expect(source.slice(tj.start, tj.end)).toBe("(a\\)b(c)) Tj");
    expect(new TextDecoder().decode((tj.operands[0] as { bytes: Uint8Array }).bytes)).toBe("a)b(c)");
    expect(source.slice(ops[5].start, ops[5].end)).toBe("BI /W 1 /H 1 ID \u0000ÿEI");
  });
});

describe("analyzePage", () => {
  it("reads lines in reading order, with the spaces kerning stands for", async () => {
    const { analysis } = await analyze(
      await pdfWith(
        [
          "BT /F1 12 Tf 50 350 Td [(Hola)-280(mundo)] TJ ET",
          // One glyph per operation, drawn out of order.
          "BT /F2 14 Tf 1 0 0 1 67.892 300 Tm (c) Tj 1 0 0 1 50 300 Tm (Ab) Tj ET",
        ].join("\n"),
      ),
    );
    expect(analysis.lines.map(unitText)).toEqual(["Hola mundo", "Abc"]);
    const font = analysis.fonts[findLine(analysis, "Abc").lines[0][0].font];
    expect(font.name).toBe("Times-Bold");
    expect(font.bold).toBe(true);
  });

  it("groups lines into paragraphs and keeps paragraph breaks", async () => {
    const lines = [
      "La primera linea del parrafo",
      "continua en esta otra linea mas",
      "y termina aqui.",
      "Otro parrafo empieza con sangria",
    ];
    const { analysis } = await analyze(
      await pdfWith(
        `BT /F1 10 Tf 13 TL 50 300 Td (${lines[0]}) Tj T* (${lines[1]}) Tj T* (${lines[2]}) Tj 20 -13 Td (${lines[3]}) Tj ET`,
      ),
    );
    // The indented line starts a new paragraph.
    expect(analysis.paragraphs.map(unitText)).toEqual([lines.slice(0, 3).join(" ")]);
    const paragraph = analysis.paragraphs[0];
    expect(paragraph.align).toBe("left");
    expect(paragraph.leading).toBeCloseTo(13, 3);
    expect(analysis.paragraphOf).toEqual([0, 0, 0, -1]);
  });

  it("recognises justified text and the short line that ends a paragraph", async () => {
    const lines = [
      "Texto justificado que ocupa",
      "todo el ancho de la caja y",
      "estira sus espacios.",
      "Nuevo parrafo con mas texto",
      "para llenar.",
    ];
    const bytes = await pdfWith(null, async (doc, page) => {
      const helvetica = await doc.embedFont(StandardFonts.Helvetica);
      page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: doc.context.obj({ F1: helvetica.ref }) }));
      // Viewers do not kern Tj strings, so widths are summed glyph by glyph.
      const metrics = StandardFontMetrics.load("Helvetica");
      const width = (text: string) =>
        [...text].reduce((sum, c) => sum + (metrics.getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(c.codePointAt(0)!).name) ?? 0), 0) / 100;
      const shows = lines.map((line, i) => {
        const full = i === 0 || i === 1 || i === 3;
        const spaces = line.split(" ").length - 1;
        const tw = full ? (160 - width(line)) / spaces : 0;
        return `${tw.toFixed(4)} Tw (${line}) Tj T*`;
      });
      const content = `BT /F1 10 Tf 13 TL 50 300 Td ${shows.join(" ")} ET`;
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
    });
    const { analysis } = await analyze(bytes);
    expect(analysis.paragraphs).toHaveLength(1);
    const paragraph = analysis.paragraphs[0];
    expect(paragraph.align).toBe("justify");
    expect(paragraph.joins).toEqual([" ", " ", "\n", " "]);
    expect(paragraph.width).toBeCloseTo(160, 1);
    expect(paragraph.naturalWidth).toBeLessThan(160);
  });

  it("knows which characters an embedded subset can still draw", async () => {
    const bytes = await pdfWith(null, async (doc, page) => {
      doc.registerFontkit(fontkit as never);
      const noto = await doc.embedFont(NOTO_SANS, { subset: true });
      page.drawText("Hola mundo", { x: 40, y: 200, size: 16, font: noto });
    });
    // pdf-lib draws into its own content stream; the custom one above is empty.
    const doc = await PDFDocument.load(bytes);
    const analysis = analyzePage(doc.getPage(0), new FontCache(doc.context), reader);
    const font = analysis.fonts[findLine(analysis, "Hola mundo").lines[0][0].font];
    expect(Object.keys(font.glyphs)).toEqual(expect.arrayContaining(["H", "o", "l", "a", "m", "u", "n", "d", " "]));
    // Letters that were not drawn are not in the subset.
    expect(font.glyphs.Z).toBeUndefined();
  });
});

describe("applyNativeSpecs", () => {
  it("erases a line and leaves the rest of the page where it was", async () => {
    const bytes = await pdfWith(
      ["BT /F1 12 Tf 50 350 Td (Quitar esta linea) Tj ET", "BT /F1 12 Tf 50 300 Td (Esta se queda) Tj ET"].join("\n"),
    );
    const before = await textItems(bytes);
    const { doc, analysis } = await analyze(bytes);
    const unit = findLine(analysis, "Quitar");
    const after = await textItems(await apply(doc, [{ ...rewriteWithOriginal(analysis, unit, ""), runs: [] }]));
    expect(after.map((i) => i.str)).toEqual(["Esta se queda"]);
    const kept = before.find((i) => i.str === "Esta se queda")!;
    expect([after[0].x, after[0].y]).toEqual([kept.x, kept.y]);
  });

  it("removes part of a string without moving what follows", async () => {
    const bytes = await pdfWith("BT /F1 12 Tf 50 200 Td (Hola) Tj ( mundo) Tj ( adios) Tj ET");
    const { doc, analysis } = await analyze(bytes);
    // Erase only the glyphs of " mundo" (operation 4).
    const unit = findLine(analysis, "Hola mundo adios");
    const spec: NativeSpec = { ...rewriteWithOriginal(analysis, unit, ""), erase: unit.erase.filter((r) => r.startsWith("4:")), runs: [] };
    const output = await apply(doc, [spec]);
    const before = await glyphStarts(bytes);
    const after = await glyphStarts(output);
    expect(after.map((g) => g.text).join("")).toBe("Hola adios");
    const round = (list: { text: string; x: number; y: number }[]) => list.map((g) => [g.text, g.x.toFixed(3), g.y.toFixed(3)]);
    expect(round(after)).toEqual(round(before.filter((_, i) => i < 4 || i >= 10)));
  });

  it("writes new text with the document's own font", async () => {
    const bytes = await pdfWith("BT /F2 14 Tf 60 250 Td (Original) Tj ET BT /F2 14 Tf 60 150 Td (Testigo) Tj ET");
    const { doc, analysis } = await analyze(bytes);
    const unit = findLine(analysis, "Original");
    const after = await textItems(await apply(doc, [rewriteWithOriginal(analysis, unit, "Cambiado")]));
    expect(after.map((i) => i.str)).toEqual(["Cambiado", "Testigo"]);
    expect(after[0].x).toBeCloseTo(60, 3);
    expect(after[0].y).toBeCloseTo(250, 3);
    // Same font object as the untouched text: PDF.js loads it once, under one name.
    expect(after[0].fontName).toBe(after[1].fontName);
  });

  it("edits text inside a form XObject without touching its other uses", async () => {
    const bytes = await pdfWith("q 1 0 0 1 0 0 cm /Fm0 Do Q q 1 0 0 1 0 -100 cm /Fm0 Do Q", async (doc, page) => {
      const form = doc.context.flateStream(encoder.encode("BT /F1 12 Tf 50 300 Td (Encabezado) Tj ET"), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 400, 400],
      });
      const resources = page.node.get(PDFName.of("Resources")) as never;
      form.dict.set(PDFName.of("Resources"), resources);
      const xobjects = doc.context.obj({ Fm0: doc.context.register(form) });
      (page.node.get(PDFName.of("Resources")) as unknown as { set(k: PDFName, v: unknown): void }).set(
        PDFName.of("XObject"),
        xobjects,
      );
    });
    const { doc, analysis } = await analyze(bytes);
    const top = analysis.lines.find((line) => unitText(line) === "Encabezado" && line.origin[1] > 250)!;
    const after = await textItems(await apply(doc, [rewriteWithOriginal(analysis, top, "Titular")]));
    expect(after.map((i) => [i.str, Math.round(i.y)])).toEqual(
      expect.arrayContaining([
        ["Titular", 300],
        ["Encabezado", 200],
      ]),
    );
    expect(after).toHaveLength(2);
  });
});

describe("content that is rewritten", () => {
  it("keeps inline images and content split across several streams", async () => {
    const image = "BI /W 2 /H 1 /CS /G /BPC 8 ID \u0000ÿ EI";
    const bytes = await pdfWith(null, async (doc, page) => {
      const first = doc.context.flateStream(Uint8Array.from(`q 10 0 0 10 50 50 cm ${image} Q BT /F1 12 Tf 50 300 Td (Uno) Tj`, (c) => c.charCodeAt(0)));
      const second = doc.context.flateStream(encoder.encode(" (Dos) Tj ET BT /F1 12 Tf 50 250 Td (Tres) Tj ET"));
      page.node.set(PDFName.of("Contents"), doc.context.obj([doc.context.register(first), doc.context.register(second)]));
    });
    const { doc, analysis } = await analyze(bytes);
    expect(analysis.lines.map(unitText)).toEqual(["UnoDos", "Tres"]);
    const output = await apply(doc, [{ ...rewriteWithOriginal(analysis, findLine(analysis, "Tres"), "Cuatro") }]);

    expect((await textItems(output)).map((i) => i.str)).toEqual(["UnoDos", "Cuatro"]);
    const reread = await PDFDocument.load(output);
    const content = interpretPage(reread.getPage(0), new FontCache(reread.context));
    const inline = content.operations.find((o) => o.op === "BI")!;
    expect(Array.from(content.bytes.subarray(inline.start, inline.end), (c) => String.fromCharCode(c)).join("")).toBe(image);
  });

  it("erases text shown with the ' and \" operators", async () => {
    const bytes = await pdfWith(`BT /F1 10 Tf 14 TL 50 300 Td (Primera) Tj (Segunda) ' 2 1 (Tercera) " ET`);
    const { doc, analysis } = await analyze(bytes);
    expect(analysis.lines.map(unitText)).toEqual(["Primera", "Segunda", "Tercera"]);
    const before = await glyphStarts(bytes);
    const output = await apply(doc, [{ ...rewriteWithOriginal(analysis, findLine(analysis, "Segunda"), ""), runs: [] }]);
    const after = await glyphStarts(output);
    expect(after.map((g) => g.text).join("")).toBe("PrimeraTercera");
    // The third line keeps its place: T* and the spacing of " still apply.
    const third = (list: typeof before) => list.filter((g) => g.y < 280).map((g) => [g.text, g.x.toFixed(3), g.y.toFixed(3)]);
    expect(third(after)).toEqual(third(before));
  });

  it("reads and rewrites rotated text in its own direction", async () => {
    const bytes = await pdfWith("BT /F1 12 Tf 0 1 -1 0 200 100 Tm (Vertical) Tj ET");
    const { doc, analysis } = await analyze(bytes);
    const unit = findLine(analysis, "Vertical");
    expect(unit.u[0]).toBeCloseTo(0, 6);
    expect(unit.u[1]).toBeCloseTo(1, 6);
    const output = await apply(doc, [rewriteWithOriginal(analysis, unit, "Girado")]);
    const pdf = await getDocument({ data: output.slice(), verbosity: 0 }).promise;
    const items = (await (await pdf.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
    const item = items.find((i) => i.str === "Girado")!;
    expect(item.transform.slice(0, 2).map((v) => Math.round(v))).toEqual([0, 12]);
    expect(item.transform[4]).toBeCloseTo(200, 3);
    expect(item.transform[5]).toBeCloseTo(100, 3);
  });

  it("keeps superscripts as a rise on their characters", async () => {
    const { analysis } = await analyze(await pdfWith("BT /F1 12 Tf 50 300 Td (m) Tj 4 Ts 8 Tf (2) Tj 0 Ts ET".replace("8 Tf", "/F1 8 Tf")));
    const chars = findLine(analysis, "m2").lines[0];
    expect(chars.map((c) => [c.text, c.rise, c.size])).toEqual([
      ["m", 0, 12],
      ["2", 4, 8],
    ]);
  });

  it("edits two-byte (CID) fonts glyph by glyph", async () => {
    const bytes = await pdfWith(null, async (doc, page) => {
      doc.registerFontkit(fontkit as never);
      const noto = await doc.embedFont(NOTO_SANS, { subset: true });
      page.drawText("Hola mundo cruel", { x: 40, y: 200, size: 16, font: noto });
    });
    const doc = await PDFDocument.load(bytes);
    const analysis = analyzePage(doc.getPage(0), new FontCache(doc.context), reader);
    const unit = findLine(analysis, "Hola mundo cruel");
    const font = analysis.fonts[unit.lines[0][0].font];
    expect(Object.values(font.glyphs).every(([code, length]) => code < 0 || length === 2)).toBe(true);
    const output = await apply(doc, [rewriteWithOriginal(analysis, unit, "mundo Hola")]);
    const items = await textItems(output);
    expect(items.map((i) => i.str)).toEqual(["mundo Hola"]);
    expect(items[0].x).toBeCloseTo(40, 3);
  });

  it("draws characters the original font lacks with a fallback font", async () => {
    const bytes = await pdfWith("BT /F2 14 Tf 60 250 Td (Hola) Tj ET");
    const { doc, analysis } = await analyze(bytes);
    const unit = findLine(analysis, "Hola");
    const spec = rewriteWithOriginal(analysis, unit, "Hola");
    spec.runs.push({
      font: { kind: "fallback", family: "Helvetica, Arial, sans-serif", weight: "normal", style: "normal", substitute: true },
      size: 14,
      color: { space: "rgb", components: [1, 0, 0] },
      glyphs: [{ text: "Ω", x: 40, y: 0 }],
    });
    const helvetica: ApplyResources = {
      fallbackFont: async () => {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        return { font, prepare: (text) => (text === "Ω" ? "?" : text) };
      },
    };
    const report = await applyNativeSpecs(doc.getPage(0), [spec], new FontCache(doc.context), helvetica);
    expect(report.failed).toEqual([]);
    const items = await textItems(await doc.save());
    expect(items.map((i) => i.str).join("")).toBe("Hola?");
    expect(new Set(items.map((i) => i.fontName)).size).toBe(2);
  });
});

describe("appendUpdate", () => {
  it("adds the edited page as an update that PDF.js reads, leaving other pages alone", async () => {
    const source = await PDFDocument.create();
    const helvetica = await source.embedFont(StandardFonts.Helvetica);
    for (const label of ["Primera", "Segunda"]) source.addPage([300, 200]).drawText(label, { x: 20, y: 100, size: 14, font: helvetica });
    const base = await normalizedBase(await source.save());

    const doc = await PDFDocument.load(base);
    const largest = doc.context.largestObjectNumber;
    const fonts = new FontCache(doc.context);
    const analysis = analyzePage(doc.getPage(1), fonts, reader);
    const page = doc.getPage(1);
    const unit = findLine(analysis, "Segunda");
    const report = await applyNativeSpecs(page, [rewriteWithOriginal(analysis, unit, "Segundo")], fonts, fallbackOnly);
    expect(report.failed).toEqual([]);
    const updated = await appendUpdate(base, doc, largest, [page.ref]);

    // The original bytes are untouched: the update is appended.
    expect(updated.subarray(0, base.length)).toEqual(base);
    const tail = new TextDecoder("latin1").decode(updated.subarray(base.length));
    expect(tail).toMatch(/\/Prev \d+/);
    const pdf = await getDocument({ data: updated.slice(), verbosity: 0 }).promise;
    const texts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent();
      texts.push(items.map((item) => ("str" in item ? item.str : "")).join(""));
    }
    expect(texts).toEqual(["Primera", "Segundo"]);
  });
});

describe("TextDocument", () => {
  it("builds one preview after another from the same parsed document", async () => {
    const source = await PDFDocument.create();
    const helvetica = await source.embedFont(StandardFonts.Helvetica);
    source.addPage([300, 200]).drawText("Hola mundo", { x: 20, y: 100, size: 14, font: helvetica });
    const document = await TextDocument.open(await source.save(), undefined, fontkit);
    const analysis = await document.analyze(0);
    const unit = findLine(analysis, "Hola mundo");

    const first = await document.derive(0, [rewriteWithOriginal(analysis, unit, "Adios")], {});
    // Characters Helvetica lacks are drawn with a fallback, which embeds a font.
    const withFallback = rewriteWithOriginal(analysis, unit, "Hola");
    withFallback.runs.push({
      font: { kind: "fallback", family: "Helvetica, Arial, sans-serif", weight: "bold", style: "normal" },
      size: 14,
      color: { space: "gray", components: [0] },
      glyphs: [{ text: "!", x: 40, y: 0 }],
    });
    const second = await document.derive(0, [withFallback], {});
    const third = await document.derive(0, [rewriteWithOriginal(analysis, unit, "Mundo")], {});

    const text = async (bytes: Uint8Array) => (await textItems(bytes)).map((i) => i.str).join("");
    expect(await text(first.bytes)).toBe("Adios");
    expect(await text(second.bytes)).toBe("Hola!");
    expect(await text(third.bytes)).toBe("Mundo");
    // Each preview is the base plus one update: nothing piles up between them.
    expect(third.bytes.length - document.base.length).toBeLessThan(second.bytes.length - document.base.length);
    // The parsed document is back to the original.
    expect(await text(await document.doc.save())).toBe("Hola mundo");
  });
});

describe("fonts written like word processors do", () => {
  /** A simple TrueType font with WinAnsi encoding and explicit widths, as Word writes them. */
  async function wordLikePdf(content: string): Promise<Uint8Array> {
    const program = fontkit.create(NOTO_SANS as never) as unknown as {
      unitsPerEm: number;
      glyphForCodePoint(cp: number): { advanceWidth: number };
    };
    const winAnsi = new TextDecoder("windows-1252");
    const widths: number[] = [];
    for (let code = 32; code <= 255; code++) {
      const char = winAnsi.decode(Uint8Array.of(code));
      widths.push(Math.round((program.glyphForCodePoint(char.codePointAt(0)!).advanceWidth * 1000) / program.unitsPerEm));
    }
    return pdfWith(content, async (doc, page) => {
      const file = doc.context.flateStream(NOTO_SANS);
      const descriptor = doc.context.obj({
        Type: "FontDescriptor",
        FontName: "ABCDEF+NotoSans-Regular",
        Flags: 32,
        Ascent: 1069,
        Descent: -293,
        ItalicAngle: 0,
        FontBBox: [-621, -389, 2800, 1067],
        StemV: 80,
        FontFile2: doc.context.register(file),
      });
      const font = doc.context.obj({
        Type: "Font",
        Subtype: "TrueType",
        BaseFont: "ABCDEF+NotoSans-Regular",
        Encoding: "WinAnsiEncoding",
        FirstChar: 32,
        LastChar: 255,
        Widths: widths,
        FontDescriptor: doc.context.register(descriptor),
      });
      const resources = page.node.get(PDFName.of("Resources")) as unknown as { lookup(k: PDFName): { set(k: PDFName, v: unknown): void } };
      resources.lookup(PDFName.of("Font")).set(PDFName.of("TT0"), doc.context.register(font));
    });
  }

  it("reads kerned text and rewrites it with the same font, checking glyphs in the program", async () => {
    const bytes = await wordLikePdf(
      "BT /TT0 12 Tf 50 300 Td [(W)60(ord)-10( )-20(k)8(erning)] TJ ET BT /TT0 12 Tf 50 250 Td (Testigo) Tj ET",
    );
    const { doc, analysis } = await analyze(bytes);
    const unit = findLine(analysis, "Word kerning");
    const font = analysis.fonts[unit.lines[0][0].font];
    expect(font.name).toBe("NotoSans-Regular");
    // Not on the page, but present in the embedded program.
    expect(font.glyphs.Z).toBeDefined();
    expect(font.glyphs["ñ"]).toBeDefined();

    const items = await textItems(await apply(doc, [rewriteWithOriginal(analysis, unit, "Zaña")]));
    expect(items.map((i) => i.str)).toEqual(["Zaña", "Testigo"]);
    expect(items[0].fontName).toBe(items[1].fontName);
  });
});
