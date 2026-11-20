import { PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFContext, type PDFDict } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FontCache, PdfFont, standardFontName } from "./fonts";

let context: PDFContext;
beforeAll(async () => {
  context = (await PDFDocument.create()).context;
});

const font = (entries: Record<string, unknown>) => new PdfFont(context, context.obj(entries as never), "f");
const stream = (text: string, dict: Record<string, unknown> = {}) =>
  context.register(context.flateStream(new TextEncoder().encode(text), dict as never));

const toUnicode = (pairs: string) =>
  stream(`1 begincodespacerange <00> <FF> endcodespacerange ${pairs.split(";").length} beginbfchar ${pairs.replaceAll(";", " ")} endbfchar`);

describe("simple fonts", () => {
  it("reads objects that are not dictionaries as an empty Type 1 font", () => {
    const empty = new PdfFont(context, PDFNumber.of(1), "x");
    expect(empty.subtype).toBe("Type1");
    expect(empty.baseName).toBe("");
    expect(empty.embedded).toBe(false);
    expect(empty.codeLength(0x41)).toBe(1);
    expect(empty.cid(65)).toBe(65);
  });

  it("uses the standard metrics of subset fonts named after the standard 14", () => {
    const arial = font({ Type: "Font", Subtype: "TrueType", BaseFont: "ABCDEF+Arial-BoldItalic" });
    expect(arial).toMatchObject({ subset: true, name: "Arial-BoldItalic", bold: true, italic: true, serif: false });
    expect(arial.width(65)).toBe(722);
    // Codes without a glyph name fall back to the default width.
    expect(arial.width(1)).toBe(0);
    expect(arial.unicode(65)).toBe("A");
    expect(arial.unicode(1)).toBeUndefined();
  });

  it("prefers the widths the font lists", () => {
    const listed = font({ BaseFont: "Helvetica", FirstChar: 65, Widths: [600, 610] });
    expect(listed.width(66)).toBe(610);
    expect(listed.width(67)).toBe(0);
  });

  it("maps Symbol and ZapfDingbats through their own encodings", () => {
    expect(font({ BaseFont: "Symbol" }).unicode(0x61)).toBe("α");
    expect(font({ BaseFont: "ZapfDingbats" }).unicode(0x21)).toBe("✁");
  });

  it("reads encodings by name, by base and differences, or none for symbolic fonts", () => {
    const winAnsi = font({ BaseFont: "Foo", Encoding: "WinAnsiEncoding" });
    expect(winAnsi.unicode(0x80)).toBe("€");
    const unknown = font({ BaseFont: "Foo", Encoding: "Desconocida" });
    expect(unknown.unicode(0x41)).toBe("A");
    const differences = font({
      BaseFont: "Foo",
      Encoding: { BaseEncoding: "MacRomanEncoding", Differences: [65, "Alpha", "B", (300).toString(), 300, "C", "(x)", 66] },
    });
    expect(differences.unicode(65)).toBe("Α");
    expect(differences.unicode(66)).toBe("B");
    const symbolic = font({ BaseFont: "Foo", FontDescriptor: { Flags: 4 } });
    expect(symbolic.unicode(0x41)).toBeUndefined();
    const symbolicWithBase = font({ BaseFont: "Foo", FontDescriptor: { Flags: 4 }, Encoding: { BaseEncoding: "WinAnsiEncoding" } });
    expect(symbolicWithBase.unicode(0x41)).toBe("A");
  });

  it("scales Type 3 fonts by their matrix and box", () => {
    const type3 = font({ Subtype: "Type3", FontMatrix: [0.01, 0, 0, 0.01, 0, 0], FontBBox: [0, -20, 100, 80], FirstChar: 1, Widths: [50] });
    expect(type3.scale).toBe(0.01);
    expect(type3.ascent).toBeCloseTo(0.8);
    expect(type3.descent).toBeCloseTo(-0.2);
    expect(type3.width(1)).toBe(50);
    const bare = font({ Subtype: "Type3", FontBBox: [0, 0, 1, 1], FontMatrix: [0.001, 0, 0, 0, 0, 0] });
    expect(bare.scale).toBe(0.001);
    expect(font({ Subtype: "Type3" }).scale).toBe(0.001);
  });

  it("reads text from ToUnicode, then from the program, ignoring NUL mappings", () => {
    const mapped = font({ BaseFont: "Foo", ToUnicode: toUnicode("<41> <0042>;<43> <0000>") });
    expect(mapped.unicode(0x41)).toBe("B");
    expect(mapped.unicode(0x43)).toBe("C");
    expect(mapped.hasToUnicode).toBe(true);
    mapped.setProgramUnicode(new Map([[0x43, "ç"], [0x300, "ŝ"]]));
    expect(mapped.unicode(0x43)).toBe("ç");
    expect(mapped.mappedCodes()).toEqual(expect.arrayContaining([0x41, 0x43, 0x300]));
    expect(font({ BaseFont: "Foo" }).hasToUnicode).toBe(false);
  });
});

describe("font descriptors", () => {
  it("reads flags, angles, weights and missing widths", () => {
    const described = font({
      BaseFont: "Foo",
      FontDescriptor: { Flags: 1 | 2, ItalicAngle: -12, FontWeight: 700, MissingWidth: 333, Ascent: 2000, Descent: -900 },
    });
    expect(described).toMatchObject({ monospace: true, serif: true, italic: true, bold: true, symbolic: false });
    expect(described.width(65)).toBe(333);
    expect(described.ascent).toBe(1.3);
    expect(described.descent).toBe(-0.6);
    const flagged = font({ BaseFont: "Foo", FontDescriptor: { Flags: 64 | 0x40000 | 4 | 32 } });
    expect(flagged).toMatchObject({ italic: true, bold: true, symbolic: false });
  });

  it("uses the standard font's metrics, or typical ones, when the descriptor has none", () => {
    expect(font({ BaseFont: "Courier" })).toMatchObject({ monospace: true, serif: false });
    expect(font({ BaseFont: "Times-Roman" })).toMatchObject({ serif: true });
    const plain = font({ BaseFont: "Foo", FontDescriptor: {} });
    expect(plain.ascent).toBe(0.8);
    expect(plain.descent).toBe(-0.2);
    expect(font({ BaseFont: "Symbol", FontDescriptor: {} }).ascent).toBeGreaterThan(0);
  });

  it("finds the embedded program of each kind", () => {
    const file = (subtype?: string) => stream("x", subtype ? { Subtype: subtype } : {});
    expect(font({ FontDescriptor: { FontFile2: file() } }).program?.kind).toBe("TrueType");
    expect(font({ FontDescriptor: { FontFile3: file("OpenType") } }).program?.kind).toBe("OpenType");
    expect(font({ FontDescriptor: { FontFile3: file("Type1C") } }).program?.kind).toBe("CFF");
    expect(font({ FontDescriptor: { FontFile: file() } }).program?.kind).toBe("Type1");
    expect(font({ FontDescriptor: {} }).program).toBeUndefined();
  });

  it("takes style from the name", () => {
    expect(font({ BaseFont: "Garamond-SemiboldKursiv" })).toMatchObject({ bold: true, italic: true, serif: true });
    expect(font({ BaseFont: "Consolas" })).toMatchObject({ monospace: true });
    expect(font({ BaseFont: "OpenSans-Regular" }).serif).toBe(false);
    expect(font({ BaseFont: "SansSerifBold" }).serif).toBe(false);
  });

  it("suggests CSS families from the name", () => {
    expect(font({ BaseFont: "TimesNewRomanPSMT" }).cssFamilies()).toEqual(["TimesNewRoman", "Times New Roman"]);
    expect(font({ BaseFont: "X" }).cssFamilies()).toEqual([]);
  });
});

describe("composite fonts", () => {
  const descendant = (extra: Record<string, unknown> = {}) => [{ Type: "Font", Subtype: "CIDFontType2", DW: 900, W: [1, [100, 200], 10, 20, 300], ...extra }];

  it("reads CID widths in both forms and the default width", () => {
    const composite = font({ Subtype: "Type0", BaseFont: "Noto", Encoding: "Identity-H", DescendantFonts: descendant() });
    expect(composite.composite).toBe(true);
    expect(composite.readCodes(Uint8Array.of(0, 1, 0, 2))).toEqual([
      { code: 1, length: 2 },
      { code: 2, length: 2 },
    ]);
    expect([1, 2, 15, 30].map((code) => composite.width(code))).toEqual([100, 200, 300, 900]);
    expect(composite.codeLength(5)).toBe(2);
    expect(composite.unicode(1)).toBeUndefined();
    expect(composite.mappedCodes()).toEqual([]);
  });

  it("writes vertically with Identity-V or a vertical CMap", () => {
    expect(font({ Subtype: "Type0", Encoding: "Identity-V" }).vertical).toBe(true);
    const cmap = stream("1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <00> <FF> 5 endcidrange", { WMode: 1 });
    const vertical = font({ Subtype: "Type0", Encoding: cmap });
    expect(vertical.vertical).toBe(true);
    expect(vertical.cid(3)).toBe(8);
    expect(vertical.readCodes(Uint8Array.of(3))).toEqual([{ code: 3, length: 1 }]);
  });

  it("cannot read codes without a usable encoding", () => {
    const named = font({ Subtype: "Type0", Encoding: "UniGB-UCS2-H", DescendantFonts: [{ Subtype: "CIDFontType0" }] });
    expect(named.decodable).toBe(false);
    expect(named.readCodes(Uint8Array.of(1, 2))).toEqual([]);
    expect(named.codeLength(1)).toBe(2);
    expect(named.cid(7)).toBe(7);
    const empty = font({ Subtype: "Type0", Encoding: stream("") });
    expect(empty.decodable).toBe(false);
    const unmapped = font({ Subtype: "Type0", Encoding: stream("1 begincodespacerange <00> <FF> endcodespacerange") });
    expect(unmapped.cid(9)).toBe(9);
  });

  it("maps CIDs to glyphs for embedded TrueType programs", () => {
    const program = { FontDescriptor: { FontFile2: stream("x") } };
    const identity = font({ Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: descendant(program) });
    expect(identity.cidToGid).toBe("identity");
    const named = font({ Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: descendant({ ...program, CIDToGIDMap: "Identity" }) });
    expect(named.cidToGid).toBe("identity");
    const map = context.register(context.stream(Uint8Array.of(0, 5, 1, 0)));
    const table = font({ Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: descendant({ ...program, CIDToGIDMap: map }) });
    expect([...(table.cidToGid as Uint16Array)]).toEqual([5, 256]);
    const broken = font({ Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: descendant({ ...program, CIDToGIDMap: 3 }) });
    expect(broken.cidToGid).toBeUndefined();
  });
});

describe("standard font names", () => {
  it("resolves aliases and styles of the standard 14", () => {
    expect(["TimesNewRoman,BoldItalic", "Times-Bold", "Times Italic", "Times"].map(standardFontName)).toEqual([
      "Times-BoldItalic",
      "Times-Bold",
      "Times-Italic",
      "Times-Roman",
    ]);
    expect(["Arial,BoldItalic", "Helvetica-Oblique", "CourierNew_Bold", "Courier"].map(standardFontName)).toEqual([
      "Helvetica-BoldOblique",
      "Helvetica-Oblique",
      "Courier-Bold",
      "Courier",
    ]);
    expect(standardFontName("Verdana")).toBeUndefined();
  });
});

describe("font cache", () => {
  it("loads each font once, inline or indirect", () => {
    const cache = new FontCache(context);
    const dict = context.obj({ BaseFont: "Helvetica" }) as PDFDict;
    const ref = context.register(context.obj({ BaseFont: "Times-Roman" }));
    expect(cache.get(dict)).toBe(cache.get(dict));
    expect(cache.get(ref)).toBe(cache.get(ref));
    expect(cache.get(dict)?.id).toMatch(/^inline-/);
  });

  it("gives up on fonts it cannot read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = new Proxy(context.obj({}), {
      get(target, key) {
        if (key === "get") throw new Error("roto");
        return Reflect.get(target, key);
      },
    });
    expect(new FontCache(context).get(broken)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(PDFHexString.of("00")).toBeDefined();
    expect(PDFName.of("A")).toBeDefined();
  });
});
