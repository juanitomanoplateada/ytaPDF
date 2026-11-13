import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@cantoo/fontkit";
import { PDFDocument } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { familyFromCss, FONT_FAMILIES, scriptFontFor, type ScriptFontId } from "../fonts";
import { DrawContext, drawOnPage, type FontkitLike, type TextDrawable } from "./drawing";

const require = createRequire(import.meta.url);
const SCRIPT_FILES: Record<ScriptFontId, string> = {
  "noto-sans-arabic": "@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf",
  "noto-sans-sc": "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf",
  "noto-sans-kr": "@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf",
};

function text(content: string): TextDrawable {
  return {
    kind: "text",
    matrix: [1, 0, 0, 1, 50, 100],
    lines: [{ text: content, x: 0, baseline: 0 }],
    fontSize: 16,
    fontFamily: FONT_FAMILIES[0].css,
    color: { r: 0, g: 0, b: 0 },
    opacity: 1,
    underline: false,
  };
}

describe("script fonts", () => {
  it("knows which font draws each script", () => {
    expect(scriptFontFor("a")).toBeNull();
    expect(scriptFontFor("ñ")).toBeNull();
    expect(scriptFontFor("س")).toBe("noto-sans-arabic");
    expect(scriptFontFor("中")).toBe("noto-sans-sc");
    expect(scriptFontFor("あ")).toBe("noto-sans-sc");
    expect(scriptFontFor("한")).toBe("noto-sans-kr");
  });

  it("still tells families apart now that their stacks end with the script fonts", () => {
    for (const family of FONT_FAMILIES) expect(familyFromCss(family.css).id).toBe(family.id);
    expect(familyFromCss('Helvetica, Arial, "Liberation Sans", sans-serif').id).toBe("helvetica");
    expect(familyFromCss('"Noto Serif", serif').id).toBe("noto-serif");
  });

  it("draws Chinese, Korean and Arabic with their own fonts next to a standard font", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const requested: string[] = [];
    const context = new DrawContext(doc, {
      loadImage: async () => {
        throw new Error("sin imágenes");
      },
      loadScriptFont: async (id) => {
        requested.push(id);
        return new Uint8Array(readFileSync(require.resolve(SCRIPT_FILES[id])));
      },
      fontkit: fontkit as unknown as FontkitLike,
    });
    await drawOnPage(page, [text("Hola 中文 한국어 مرحبا")], [1, 0, 0, -1, 0, 200], context);
    expect(new Set(requested)).toEqual(new Set(["noto-sans-sc", "noto-sans-kr", "noto-sans-arabic"]));
    expect(context.unsupportedChars.size).toBe(0);

    const pdf = await getDocument({ data: (await doc.save()).slice(), verbosity: 0 }).promise;
    const { items } = await (await pdf.getPage(1)).getTextContent();
    const extracted = items.map((item) => ("str" in item ? item.str : "")).join("");
    expect(extracted).toContain("Hola");
    expect(extracted).toContain("中文");
    expect(extracted).toContain("한국어");
    // Arabic is shaped (joined forms); its letters are still there.
    expect(extracted.normalize("NFKC")).toMatch(/[؀-ۿ]/);
  });
});
