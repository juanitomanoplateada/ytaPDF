import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFPage, type PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { FontCache } from "./fonts";
import { interpretPage, pageContentBytes } from "./interpreter";

const encoder = new TextEncoder();

interface Built {
  doc: PDFDocument;
  page: PDFPage;
  helvetica: PDFRef;
}

/** A page whose resources `extra` fills and whose content is `content`. */
async function pageWith(content: string, extra: (built: Built) => Record<string, unknown> = () => ({})): Promise<Built> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const helvetica = (await doc.embedFont(StandardFonts.Helvetica)).ref;
  const built = { doc, page, helvetica };
  const resources = { Font: { F1: helvetica }, ...extra(built) };
  page.node.set(PDFName.of("Resources"), doc.context.obj(resources as never));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
  // pdf-lib writes the dictionaries of embedded fonts when it flushes.
  await doc.flush();
  return built;
}

const run = (built: Built, options = { trackCtm: true, trackPaints: true }) => interpretPage(built.page, new FontCache(built.doc.context), options);
const form = (built: Built, content: string, dict: Record<string, unknown> = {}) =>
  built.doc.context.register(built.doc.context.flateStream(encoder.encode(content), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], ...dict } as never));

describe("page content", () => {
  it("joins arrays of streams, skipping entries that are not streams", async () => {
    const built = await pageWith("");
    const { context } = built.doc;
    const a = context.register(context.flateStream(encoder.encode("q")));
    const b = context.register(context.flateStream(encoder.encode("Q")));
    built.page.node.set(PDFName.of("Contents"), context.obj([a, 5, b]));
    expect(new TextDecoder().decode(pageContentBytes(built.page).bytes)).toBe("q\nQ\n");
    built.page.node.delete(PDFName.of("Contents"));
    expect(pageContentBytes(built.page)).toEqual({ bytes: new Uint8Array(), complete: true });
  });
});

describe("colours", () => {
  it("follows device, named, ICC and other colour spaces", async () => {
    const built = await pageWith(
      [
        "/G cs 0.5 sc BT /F1 10 Tf (a) Tj ET",
        "/RGB cs 1 0 0 sc BT /F1 10 Tf (b) Tj ET",
        "/CMYK cs 0 0 0 1 scn BT /F1 10 Tf (c) Tj ET",
        "/CalRGB cs BT /F1 10 Tf (d) Tj ET",
        "/Alias cs BT /F1 10 Tf (e) Tj ET",
        "/Icc1 cs BT /F1 10 Tf (f) Tj ET",
        "/Icc4 cs BT /F1 10 Tf (g) Tj ET",
        "/IccBad cs BT /F1 10 Tf (h) Tj ET",
        "/Gray cs BT /F1 10 Tf (i) Tj ET",
        "/Lab cs BT /F1 10 Tf (j) Tj ET",
        "/Spot cs 0.25 scn BT /F1 10 Tf (k) Tj ET",
        "/Spot cs /P1 scn BT /F1 10 Tf (l) Tj ET",
        "/Odd cs BT /F1 10 Tf (m) Tj ET",
        "5 cs BT /F1 10 Tf (n) Tj ET",
        "/RGB cs 0.5 sc BT /F1 10 Tf (o) Tj ET",
        "0.2 g BT /F1 10 Tf (p) Tj ET",
        "0 1 0 rg BT /F1 10 Tf (q) Tj ET",
        "0 0 1 0 k BT /F1 10 Tf (r) Tj ET",
      ].join("\n"),
      ({ doc }) => {
        const icc = (n: number) => doc.context.register(doc.context.stream(new Uint8Array(), { N: n }));
        return {
          ColorSpace: {
            Alias: "DeviceRGB",
            Icc1: ["ICCBased", icc(1)],
            Icc4: ["ICCBased", icc(4)],
            IccBad: ["ICCBased", 7],
            Gray: ["CalGray", {}],
            Lab: ["Lab", {}],
            Spot: ["Separation", "Spot", "DeviceCMYK", 0],
            Odd: 5,
          },
        };
      },
    );
    const colours = Object.fromEntries(run(built).glyphs.map((g) => [g.unicode, g.color]));
    expect(colours).toMatchObject({
      a: { space: "gray", components: [0.5] },
      b: { space: "rgb", components: [1, 0, 0] },
      c: { space: "cmyk", components: [0, 0, 0, 1] },
      d: { space: "rgb", components: [0, 0, 0] },
      e: { space: "rgb" },
      f: { space: "gray" },
      g: { space: "cmyk", components: [0, 0, 0, 1] },
      h: { space: "rgb" },
      i: { space: "gray" },
      j: { space: "rgb" },
      k: { space: "gray", components: [0.75] },
      l: { space: "gray", components: [0] },
      m: { space: "gray", components: [0] },
      n: { space: "gray", components: [0] },
      o: { space: "gray", components: [0.5] },
      p: { space: "gray", components: [0.2] },
      q: { space: "rgb", components: [0, 1, 0] },
      r: { space: "cmyk", components: [0, 0, 1, 0] },
    });
  });
});

describe("text state", () => {
  it("follows spacing, scaling, leading, rise and rendering mode", async () => {
    const built = await pageWith(
      "BT /F1 10 Tf 2 Tc 3 Tw 50 Tz 12 TL 4 Ts 1 Tr 10 20 Td (a ) Tj T* (b) Tj 5 -14 TD (c) Tj 1 0 0 1 100 100 Tm (d) Tj 1 2 (e) \" (f) ' ET",
    );
    const glyphs = run(built).glyphs;
    const a = glyphs[0];
    expect(a).toMatchObject({ charSpacing: 2, wordSpacing: 3, hScale: 0.5, rise: 4, renderMode: 1 });
    // The space gets the word spacing as well.
    expect(glyphs[1].advance - (glyphs[1].width + 2 * 0.5)).toBeCloseTo(1.5);
    expect(glyphs.find((g) => g.unicode === "b")!.textMatrix[5]).toBe(8);
    expect(glyphs.find((g) => g.unicode === "c")!.textMatrix.slice(4)).toEqual([15, -6]);
    expect(glyphs.find((g) => g.unicode === "d")!.textMatrix.slice(4)).toEqual([100, 100]);
    const e = glyphs.find((g) => g.unicode === "e")!;
    expect(e).toMatchObject({ wordSpacing: 1, charSpacing: 2 });
    expect(e.textMatrix[5]).toBe(100 - 14);
    expect(glyphs.find((g) => g.unicode === "f")!.textMatrix[5]).toBe(100 - 28);
  });

  it("skips text without a font, unknown fonts and odd operands", async () => {
    const built = await pageWith("/x Tc BT (a) Tj /F9 10 Tf (b) Tj 5 10 Tf (c) Tj /F1 10 Tf Tj (d) TJ [(e) -500 (f)] TJ ' ET Q 1 2 cm");
    const glyphs = run(built).glyphs;
    expect(glyphs.map((g) => g.unicode)).toEqual(["e", "f"]);
    // "e" is 5.56 wide at 10 points, and -500 moves "f" 5 further.
    expect(glyphs[1].textMatrix[4]).toBeCloseTo(10.56);
  });

  it("moves vertical text down, numbers in TJ included", async () => {
    const built = await pageWith("BT /V 10 Tf [<0001> 500 <0002>] TJ ET", ({ doc, helvetica }) => ({
      Font: {
        F1: helvetica,
        V: doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "X", Encoding: "Identity-V", DescendantFonts: [{ Subtype: "CIDFontType0", DW: 1000 }] })),
      },
    }));
    const [first, second] = run(built).glyphs;
    expect(first.vertical).toBe(true);
    expect(first.advance).toBe(0);
    // Down by the em, then 500/1000 of it further.
    expect(second.textMatrix[5]).toBe(-15);
  });

  it("takes alpha and fonts from graphics state dictionaries", async () => {
    const built = await pageWith("/Missing gs 5 gs /Half gs /Font1 gs /FontShort gs BT (a) Tj ET", ({ helvetica }) => ({
      ExtGState: { Half: { ca: 0.5 }, Font1: { Font: [helvetica, 14] }, FontShort: { Font: [helvetica] } },
    }));
    expect(run(built).glyphs[0]).toMatchObject({ alpha: 0.5, size: 14 });
  });
});

describe("painting", () => {
  it("records paths, images and shadings, and ignores them when not asked", async () => {
    const content = "1 2 desconocido 0 0 m 10 0 l 10 10 20 20 30 30 c 1 1 2 2 v 3 3 4 4 y h S 5 5 10 10 re f n n 0 0 m n BI /W 1 /H 1 ID x EI sh q 10 0 0 10 0 0 cm /Im Do Q /Inline Do 7 Do";
    const built = await pageWith(content, ({ doc }) => ({
      XObject: {
        Im: doc.context.register(doc.context.stream(Uint8Array.of(0), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: "DeviceGray" })),
        Inline: doc.context.stream(Uint8Array.of(0), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: "DeviceGray" }),
      },
    }));
    const tracked = run(built);
    expect(tracked.paints.map((p) => p.kind)).toEqual(["path", "path", "image", "shading", "image", "image"]);
    expect(tracked.paints[4].ref).toBeDefined();
    expect(tracked.paints[5].ref).toBeUndefined();
    expect(tracked.paints[4].points[2]).toEqual([10, 10]);
    expect(tracked.ctmAfter).toHaveLength(tracked.operations.length);
    const untracked = run(built, { trackCtm: false, trackPaints: false });
    expect(untracked.paints).toEqual([]);
    expect(untracked.ctmAfter).toEqual([]);
  });
});

describe("forms", () => {
  it("reads text inside forms with their matrix and resources, numbering their text objects", async () => {
    const built = await pageWith("BT /F1 10 Tf (a) Tj ET /Fm Do /Direct Do", (b) => {
      const inner = form(b, "BT /F1 10 Tf (c) Tj ET");
      return {
        XObject: {
          Fm: form(b, "BT /F1 10 Tf (b) Tj ET /In Do", { Matrix: [1, 0, 0, 1, 50, 50], Resources: { Font: { F1: b.helvetica }, XObject: { In: inner } } }),
          Direct: b.doc.context.flateStream(encoder.encode("BT /F1 10 Tf (d) Tj ET"), { Type: "XObject", Subtype: "Form" } as never),
        },
      };
    });
    const content = run(built);
    const byText = Object.fromEntries(content.glyphs.map((g) => [g.unicode, g]));
    expect(byText.b.ctm.slice(4)).toEqual([50, 50]);
    expect(byText.b.insertAfter).toBe("4");
    expect(byText.c.path).toBe("4/4/");
    expect(byText.c.textObject).toBe(byText.b.textObject);
    expect(byText.d.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(byText.a.textObject).not.toBe(byText.d.textObject);
    expect([...content.forms.keys()]).toEqual(["4/", "4/4/", "5/"]);
  });

  it("skips images, non-streams, recursion, deep nesting and forms it cannot decode", async () => {
    const built = await pageWith("/Im Do /Num Do /Self Do /Deep0 Do /Broken Do /Missing Do", (b) => {
      const { context } = b.doc;
      const self = context.nextRef();
      context.assign(self, context.flateStream(encoder.encode("BT /F1 10 Tf (s) Tj ET /Self Do"), { Type: "XObject", Subtype: "Form", Resources: { Font: { F1: b.helvetica }, XObject: { Self: self } } } as never));
      // Ten forms, each drawing the next one.
      const deep: PDFRef[] = [];
      for (let i = 9; i >= 0; i--) {
        const xobjects = deep.length > 0 ? { [`Deep${i + 1}`]: deep[0] } : {};
        deep.unshift(form(b, `BT /F1 10 Tf (${i}) Tj ET /Deep${i + 1} Do`, { Resources: { Font: { F1: b.helvetica }, XObject: xobjects } }));
      }
      return {
        XObject: {
          Im: context.register(context.stream(Uint8Array.of(0), { Subtype: "Image", Width: 1, Height: 1 })),
          Num: 4,
          Self: self,
          Deep0: deep[0],
          Broken: context.register(PDFRawStream.of(context.obj({ Subtype: "Form", Filter: "JBIG2Decode" }), Uint8Array.of(1))),
        },
      };
    });
    const content = run(built, { trackCtm: false, trackPaints: false });
    const texts = content.glyphs.map((g) => g.unicode);
    expect(texts.filter((t) => t === "s")).toHaveLength(1);
    expect(texts.filter((t) => /\d/.test(t ?? ""))).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(content.complete).toBe(false);
    expect(PDFArray).toBeDefined();
  });
});
