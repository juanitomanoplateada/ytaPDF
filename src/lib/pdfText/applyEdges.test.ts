import { PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFPage } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { applyNativeSpecs, type ApplyResources } from "./apply";
import { FontCache } from "./fonts";
import { interpretPage, pageContentBytes } from "./interpreter";
import type { NativeSpec } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

interface Page {
  doc: PDFDocument;
  page: PDFPage;
  fonts: FontCache;
}

/** A page with Helvetica as /F1, a form /Fm with text and an image /Im, reloaded as real files are. */
async function pageWith(content: string, formContent = "BT /F1 10 Tf 0 0 Td (forma) Tj ET"): Promise<Page> {
  const source = await PDFDocument.create();
  const page = source.addPage([400, 400]);
  const helvetica = await source.embedFont(StandardFonts.Helvetica);
  const { context } = source;
  const image = context.register(context.stream(Uint8Array.of(0), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  const form = context.register(
    context.flateStream(encoder.encode(formContent), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: { Font: { F1: helvetica.ref } } } as never),
  );
  page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: helvetica.ref }, XObject: { Fm: form, Im: image } } as never));
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(encoder.encode(content))));
  const doc = await PDFDocument.load(await source.save());
  return { doc, page: doc.getPage(0), fonts: new FontCache(doc.context) };
}

const contentOf = (page: PDFPage) => decoder.decode(pageContentBytes(page).bytes);

const spec = (changes: Partial<NativeSpec>): NativeSpec => ({
  id: "s",
  erase: [],
  insertAfter: "end",
  matrix: [1, 0, 0, 1, 0, 0],
  renderMode: 0,
  runs: [],
  underlines: [],
  ...changes,
});

const underline = (components: number[]) => ({ color: { space: "rgb" as const, components }, x: 0, y: 0, width: 10, thickness: 1 });

/** Fallback fonts are Helvetica, embedded into the edited document (anew for each run). */
const helveticaFallback = (doc: PDFDocument): ApplyResources => ({
  fallbackFont: async () => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { font, prepare: (text) => text.replace("Ж", "") };
  },
});

describe("applying edits", () => {
  it("does nothing without specs or drops, and fails everything on unreadable pages", async () => {
    const { doc, page, fonts } = await pageWith("BT /F1 10 Tf (a) Tj ET");
    const before = contentOf(page);
    expect(await applyNativeSpecs(page, [], fonts, helveticaFallback(doc))).toEqual({ failed: [] });
    expect(contentOf(page)).toBe(before);
    page.node.set(PDFName.of("Contents"), doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: "JBIG2Decode" }), Uint8Array.of(1))));
    expect(await applyNativeSpecs(page, [spec({ id: "a" }), spec({ id: "b" })], fonts, helveticaFallback(doc))).toEqual({ failed: ["a", "b"] });
  });

  it("erases glyphs from every kind of text operator, keeping their advance", async () => {
    // Operations 3 to 9: TJ, ', ", Tj, a TJ without an array, a Tj and a " without operands.
    const { doc, page, fonts } = await pageWith('BT /F1 10 Tf 12 TL [(ab) -100 (cd) 50] TJ (ef) \' 1 2 (gh) " (ij) Tj 5 TJ Tj " ET');
    const erase = ["3:1-1", "4:0-0", "5:1-1", "6:0-1", "7:0-0", "8:0-0", "9:0-0"];
    await applyNativeSpecs(page, [spec({ erase })], fonts, helveticaFallback(doc));
    const content = contentOf(page);
    // The erased "b" leaves its advance, which joins the shift after it.
    expect(content).toContain("[<61> -656 <6364> 50] TJ");
    expect(content).toContain("T* [-556 <66>] TJ");
    // The advance of "h" includes the character spacing the operator set.
    expect(content).toContain("1 Tw 2 Tc T* [<67> -756] TJ");
    // "i" and "j" with the 2 points of character spacing still in force.
    expect(content).toContain("[-844] TJ\n[] TJ\n[] TJ\n0 Tw 0 Tc T* [] TJ");
  });

  it("keeps codes it has no glyphs for and treats glyphs of size 0 as having no advance", async () => {
    const { doc, page, fonts } = await pageWith("BT (sin) Tj /F1 0 Tf (cero) Tj ET");
    await applyNativeSpecs(page, [spec({ erase: ["1:0-2", "3:0-0"] })], fonts, helveticaFallback(doc));
    const content = contentOf(page);
    expect(content).toContain("[<73696e>] TJ");
    expect(content).toContain("[<65726f>] TJ");
  });

  it("drops paths, images and shadings, removing images no longer drawn", async () => {
    const { doc, page, fonts } = await pageWith("0 0 10 10 re f /Im Do sh /Fm Do /Missing Do 5 Do BT /F1 10 Tf (x) Tj ET");
    await applyNativeSpecs(page, [], fonts, helveticaFallback(doc), { drop: new Set(["1", "2", "3", "5", "6", "9"]) });
    const content = contentOf(page);
    expect(content).toContain("0 0 10 10 re\nn");
    expect(content).not.toContain("/Im Do");
    expect(content).not.toContain("sh");
    expect(content).toContain("/Fm Do");
    const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject")) as unknown as { has(key: PDFName): boolean };
    expect(xobjects.has(PDFName.of("Im"))).toBe(false);
    expect(xobjects.has(PDFName.of("Fm"))).toBe(true);
  });

  it("draws a copy of a form with something erased, keeping the original for other uses", async () => {
    const { doc, page, fonts } = await pageWith("/Fm Do /Fm Do 7 Do");
    await applyNativeSpecs(page, [spec({ erase: ["0/3:0-0"] })], fonts, helveticaFallback(doc));
    expect(contentOf(page)).toMatch(/\/YtaX0 Do\n\/Fm Do/);
    // A drop inside the form copies it too; an erasure "inside" an image changes nothing.
    const other = await pageWith("/Fm Do /Im Do");
    await applyNativeSpecs(other.page, [spec({ erase: ["1/0:0-0"] })], other.fonts, helveticaFallback(other.doc), { drop: new Set(["0/9"]) });
    expect(contentOf(other.page)).toMatch(/\/YtaX0 Do\n\/Im Do/);
  });

  it("removes descriptions of marked content that lost something, and only those", async () => {
    const { doc, page, fonts } = await pageWith(
      [
        "/Span <</ActualText (a) /Lang (es)>> BDC BT /F1 10 Tf (a) Tj ET EMC",
        "/Span /Props BDC BT /F1 10 Tf (b) Tj ET EMC",
        "/Span <</Lang (es)>> BDC BT /F1 10 Tf (c) Tj ET EMC",
        "5 <</Alt (d)>> BDC BT /F1 10 Tf (d) Tj ET EMC",
        "/Span [1] BDC /Fm Do EMC",
        "/Tag BMC /Span <</E (e)>> BDC BT /F1 10 Tf (e) Tj ET EMC EMC",
      ].join("\n"),
    );
    const ops = interpretPage(page, fonts).operations.map((op) => op.op);
    const tj = ops.flatMap((op, i) => (op === "Tj" ? [i] : []));
    const doIndex = ops.indexOf("Do");
    await applyNativeSpecs(page, [spec({ erase: [...tj.map((i) => `${i}:0-0`), `${doIndex}/3:0-0`] })], fonts, helveticaFallback(doc));
    const content = contentOf(page);
    expect(content).toContain("/Span <</Lang <6573>>> BDC");
    expect(content).toContain("/Span /Props BDC");
    expect(content).toContain("/Span <</Lang (es)>> BDC");
    expect(content).toContain("5 <</Alt (d)>> BDC");
    expect(content).toContain("/Span [1] BDC");
    expect(content).toContain("/Span <<>> BDC");
  });
});

describe("pages without resources", () => {
  it("drops what they draw all the same", async () => {
    const { doc, page, fonts } = await pageWith("/Im Do");
    page.node.delete(PDFName.of("Resources"));
    await applyNativeSpecs(page, [], fonts, helveticaFallback(doc), { drop: new Set(["0"]) });
    expect(contentOf(page)).not.toContain("Do");
  });
});

describe("drawing replacements", () => {
  it("draws with fallback fonts, skipping blank glyphs and starting new lines", async () => {
    const { doc, page, fonts } = await pageWith("BT /F1 10 Tf (a) Tj ET");
    const run = (font: NativeSpec["runs"][number]["font"]) => ({
      font,
      size: 10,
      color: { space: "cmyk" as const, components: [0, 0, 0, 1] },
      glyphs: [
        { text: "H", x: 0, y: 0 },
        { text: " ", x: 7.2, y: 0 },
        { text: "Ж", x: 9, y: 0 },
        { text: "o", x: 9.9, y: 0 },
        { text: "l", x: 15.46, y: 0 },
        { text: "a", x: 0, y: -12 },
      ],
    });
    await applyNativeSpecs(
      page,
      [spec({ runs: [run({ kind: "fallback", family: "Helvetica", weight: "normal", style: "normal" }), run({ kind: "original", sample: "nada", key: "x" })] })],
      fonts,
      helveticaFallback(doc),
    );
    const content = contentOf(page);
    expect(content).toContain("0 0 0 1 k");
    expect(content.match(/\/YtaF[01] 10 Tf/g)).toHaveLength(2);
    expect(content).toContain("1 0 0 1 0 0 Tm\n[<48> -268 <6F> <6C>] TJ\n1 0 0 1 0 -12 Tm\n[<61>] TJ");
  });

  it("writes original codes of any length and skips glyphs without one", async () => {
    const { doc, page, fonts } = await pageWith("BT /F1 10 Tf (a) Tj ET");
    const sample = interpretPage(page, fonts).glyphs[0].key;
    await applyNativeSpecs(
      page,
      [
        spec({
          runs: [
            {
              font: { kind: "original", sample, key: "k" },
              size: 10,
              color: { space: "gray", components: [0] },
              glyphs: [
                { text: "a", code: 97, x: 0, y: 0 },
                { text: "?", x: 5, y: 0 },
                { text: "?", code: -1, x: 5, y: 0 },
                { text: "b", code: 0x0062, length: 2, width: 556, x: 5.56, y: 0 },
              ],
            },
          ],
        }),
      ],
      fonts,
      helveticaFallback(doc),
    );
    // The first glyph has no width, so the second is shifted by its whole position.
    expect(contentOf(page)).toContain("[<61> -556 <0062>] TJ");
  });

  it("draws after a flat CTM with the spec's own matrix", async () => {
    const { doc, page, fonts } = await pageWith("q 0 0 0 0 0 0 cm Q");
    const report = await applyNativeSpecs(page, [spec({ insertAfter: "1", underlines: [underline([0, 0, 0])] })], fonts, helveticaFallback(doc));
    expect(report.failed).toEqual([]);
    expect(contentOf(page)).toMatch(/0 0 0 0 0 0 cm\nq\n1 0 0 1 0 0 cm/);
  });

  it("sets opacity once per value and underlines in their colours", async () => {
    const { doc, page, fonts } = await pageWith("q Q");
    await applyNativeSpecs(
      page,
      [
        spec({ id: "a", insertAfter: "0", opacity: 1.5, underlines: [underline([1, 0, 0]), underline([1, 0, 0]), underline([0, 0, 1])] }),
        spec({ id: "b", insertAfter: "x", opacity: 1, underlines: [underline([0, 0, 0])] }),
        spec({ id: "c" }),
      ],
      fonts,
      helveticaFallback(doc),
      // Content read without the CTM: drawings are placed as if it were the identity.
      { content: interpretPage(page, fonts) },
    );
    const content = contentOf(page);
    expect(content.match(/\/YtaGS0 gs/g)).toHaveLength(2);
    expect(content.match(/1 0 0 rg/g)).toHaveLength(1);
    expect(content).toContain("0 0 1 rg");
  });

  it("puts drawings at the end of pages without operations", async () => {
    const { doc, page, fonts } = await pageWith("");
    await applyNativeSpecs(page, [spec({ underlines: [{ color: { space: "gray", components: [0] }, x: 0, y: 0, width: 5, thickness: 1 }] })], fonts, helveticaFallback(doc));
    expect(contentOf(page)).toContain("0 0 5 1 re f");
  });
});
