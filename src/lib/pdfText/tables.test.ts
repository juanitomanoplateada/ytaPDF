import { describe, expect, it } from "vitest";
import {
  familyFromCss,
  fontVariant,
  isBoldWeight,
  isRtlChar,
  isWinAnsiChar,
  sanitizeForStandardFont,
  scriptFontFor,
  scriptFontsIn,
} from "../fonts";
import { identityCMap, parseCMap } from "./cmap";
import { glyphNameToUnicode, unicodeToGlyphName } from "./encodings";

describe("glyph names", () => {
  it("reads suffixed names, ligatures and uni/u names", () => {
    expect(glyphNameToUnicode("a.sc")).toBe("a");
    expect(glyphNameToUnicode("uni0041.alt")).toBe("A");
    expect(glyphNameToUnicode(".notdef")).toBeUndefined();
    expect(glyphNameToUnicode("f_i")).toBe("fi");
    expect(glyphNameToUnicode("f_desconocido")).toBeUndefined();
    expect(glyphNameToUnicode("uni00410042")).toBe("AB");
    expect(glyphNameToUnicode("uniD800")).toBeUndefined();
    expect(glyphNameToUnicode("u1F600")).toBe("😀");
    expect(glyphNameToUnicode("u110000")).toBeUndefined();
    expect(glyphNameToUnicode("uD800")).toBeUndefined();
    expect(glyphNameToUnicode("desconocido")).toBeUndefined();
  });

  it("names characters, falling back to uni and u names", () => {
    expect(unicodeToGlyphName("A")).toBe("A");
    expect(unicodeToGlyphName("Ж")).toBe("uni0416");
    expect(unicodeToGlyphName("😀")).toBe("u1F600");
    expect(unicodeToGlyphName("")).toBeUndefined();
    expect(unicodeToGlyphName("Жж")).toBeUndefined();
  });
});

const cmapSource = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/Base usecmap
5 usecmap
3 begincodespacerange
<00> <80>
<8140> <FFFF>
<00> <0000>
endcodespacerange
4 beginbfchar
<41> <0041>
<42> /B
<43> 5
5 <0041>
endbfchar
6 beginbfrange
<50> <52> <0050>
<60> <62> [<0061> /b <00> <0064>]
<63> <63> [7]
<70> <70> 5
5 <71> <0071>
<74> <75> <>
endbfrange
2 begincidchar
<0001> 7
<0002> /x
endcidchar
2 begincidrange
<8150> <8160> 100
<8170> <8180> /x
endcidrange
endcmap`;

describe("CMaps", () => {
  const cmap = parseCMap(new TextEncoder().encode(cmapSource));

  it("reads every kind of section, skipping malformed entries", () => {
    expect(cmap.useCMap).toBe("Base");
    expect(cmap.codespaces).toHaveLength(2);
    expect(Object.fromEntries(cmap.unicode)).toEqual({
      0x41: "A",
      0x42: "B",
      0x50: "P",
      0x51: "Q",
      0x52: "R",
      0x60: "a",
      0x61: "b",
      0x62: "\u0000",
      0x74: "",
      0x75: "",
    });
    expect(cmap.cid(1)).toBe(7);
    expect(cmap.cid(0x8155)).toBe(105);
    expect(cmap.cid(0x8175)).toBeUndefined();
  });

  it("reads codes by their codespace, falling back to the shortest length", () => {
    const bytes = Uint8Array.of(0x41, 0x81, 0x50, 0x90, 0x10, 0x90);
    expect(cmap.readCode(bytes, 0)).toEqual({ code: 0x41, length: 1 });
    expect(cmap.readCode(bytes, 1)).toEqual({ code: 0x8150, length: 2 });
    expect(cmap.readCode(bytes, 3)).toEqual({ code: 0x90, length: 1 });
    expect(cmap.readCode(bytes, 5)).toEqual({ code: 0x90, length: 1 });
    expect(cmap.readCode(bytes, 6)).toEqual({ code: 0, length: 1 });
    expect(parseCMap(new Uint8Array()).readCode(bytes, 1)).toEqual({ code: 0x81, length: 1 });
  });

  it("knows how long each code is written", () => {
    expect(cmap.codeLength(0x41)).toBe(1);
    expect(cmap.codeLength(0x8150)).toBe(2);
    expect(cmap.codeLength(0x90)).toBe(1);
    const empty = parseCMap(new Uint8Array());
    expect(empty.codeLength(0x41)).toBe(1);
    expect(empty.codeLength(0x4142)).toBe(2);
    expect(identityCMap().shortestCode()).toBe(2);
    expect(identityCMap().cid(0x1234)).toBe(0x1234);
  });
});

describe("font rules", () => {
  it("picks script fonts and right-to-left characters, empty text included", () => {
    expect(scriptFontFor("")).toBeNull();
    expect(scriptFontFor("Ж")).toBeNull();
    expect([...scriptFontsIn("a中ب한ж")]).toEqual(["noto-sans-sc", "noto-sans-arabic", "noto-sans-kr"]);
    expect(isRtlChar("")).toBe(false);
    expect(isRtlChar("ש")).toBe(true);
    expect(isRtlChar("ﺏ")).toBe(true);
    expect(isRtlChar("ﭐ")).toBe(true);
    expect(isRtlChar("a")).toBe(false);
  });

  it("recognises families by name when the stack is not one of the app's", () => {
    expect(familyFromCss("Noto Serif, serif").id).toBe("noto-serif");
    expect(familyFromCss("Noto Sans").id).toBe("noto-sans");
    expect(familyFromCss("Georgia, serif").id).toBe("times");
    expect(familyFromCss("DejaVu Sans Mono").id).toBe("courier");
    expect(familyFromCss("Arial").id).toBe("helvetica");
  });

  it("chooses the variant from weight and style", () => {
    expect(fontVariant("bold", "italic")).toBe("boldItalic");
    expect(fontVariant(700, "normal")).toBe("bold");
    expect(fontVariant("normal", "oblique")).toBe("italic");
    expect(fontVariant(undefined, undefined)).toBe("regular");
    expect(isBoldWeight("700")).toBe(true);
    expect(isBoldWeight("ligera")).toBe(false);
  });

  it("encodes nothing for an empty character and turns odd spaces into spaces", () => {
    expect(isWinAnsiChar("")).toBe(false);
    expect(sanitizeForStandardFont("a b")).toEqual({ text: "a b", unsupported: [] });
    expect(sanitizeForStandardFont("ЖЖ")).toEqual({ text: "??", unsupported: ["Ж"] });
  });
});
