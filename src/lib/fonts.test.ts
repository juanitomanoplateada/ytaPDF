import { describe, expect, it } from "vitest";
import { StandardFonts } from "@cantoo/pdf-lib";
import { familyFromCss, FONT_FAMILIES, sanitizeForStandardFont, standardFontFor } from "./fonts";

describe("sanitizeForStandardFont", () => {
  it("keeps Spanish text and WinAnsi punctuation intact", () => {
    const input = "Año 2026: «señal» — “ok” … 5 € ¿Qué? ¡Sí!";
    expect(sanitizeForStandardFont(input)).toEqual({ text: input, unsupported: [] });
  });

  it("substitutes common symbols with readable equivalents", () => {
    expect(sanitizeForStandardFont("a → b ≤ c\td").text).toBe("a -> b <= c    d");
  });

  it("strips diacritics WinAnsi lacks and maps undecomposable letters", () => {
    expect(sanitizeForStandardFont("Łódź Őrs").text).toBe("Lódz Ors");
  });

  it("reports characters without an equivalent", () => {
    expect(sanitizeForStandardFont("Hola 😀 世界")).toEqual({
      text: "Hola ? ??",
      unsupported: ["😀", "世", "界"],
    });
  });
});

describe("standardFontFor", () => {
  it("maps each family and style to its standard font", () => {
    const [helvetica, times, courier] = FONT_FAMILIES;
    expect(standardFontFor(helvetica.css, "normal", "normal")).toBe(StandardFonts.Helvetica);
    expect(standardFontFor(helvetica.css, "bold", "italic")).toBe(StandardFonts.HelveticaBoldOblique);
    expect(standardFontFor(times.css, 700, "normal")).toBe(StandardFonts.TimesRomanBold);
    expect(standardFontFor(times.css, "normal", "italic")).toBe(StandardFonts.TimesRomanItalic);
    expect(standardFontFor(courier.css, "bold", "normal")).toBe(StandardFonts.CourierBold);
  });

  it("recognises family names saved by earlier versions", () => {
    expect(familyFromCss("Times New Roman").id).toBe("times");
    expect(familyFromCss("Courier").id).toBe("courier");
    expect(familyFromCss("Helvetica").id).toBe("helvetica");
    expect(familyFromCss(undefined).id).toBe("helvetica");
  });
});
