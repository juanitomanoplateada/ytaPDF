import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, type PDFPage } from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { applyNativeSpecs, type ApplyResources } from "../pdfText/apply";
import { FontCache } from "../pdfText/fonts";
import type { Point } from "../polygon";
import { planRedaction, redactPage } from "./redact";

vi.mock("../pdfText/apply", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pdfText/apply")>();
  return { ...original, applyNativeSpecs: vi.fn(original.applyNativeSpecs) };
});

const noFallback: ApplyResources = {
  fallbackFont: async () => {
    throw new Error("La censura no dibuja texto");
  },
};

const BOX: Point[] = [
  [40, 190],
  [200, 190],
  [200, 265],
  [40, 265],
];

async function pageWith(content: string): Promise<{ doc: PDFDocument; page: PDFPage }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: doc.context.obj({ F1: helvetica.ref }) }));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  const loaded = await PDFDocument.load(await doc.save());
  return { doc: loaded, page: loaded.getPage(0) };
}

const redact = (doc: PDFDocument, page: PDFPage) => redactPage(page, [BOX], new FontCache(doc.context), noFallback);

describe("redaction plans", () => {
  it("leaves shadings alone and counts what lies inside", () => {
    const square: [number, number][] = [
      [50, 200],
      [60, 200],
      [60, 210],
      [50, 210],
    ];
    const plan = planRedaction(
      [],
      [
        { key: "1", kind: "shading", points: square },
        { key: "2", kind: "image", points: square },
        { key: "3", kind: "path", points: [] },
      ],
      [],
      [BOX],
    );
    expect(plan).toMatchObject({ images: 1, shapes: 0 });
    expect([...plan.drop]).toEqual(["2"]);
  });
});

describe("redacting pages", () => {
  it("removes glyphs without width by where they are", async () => {
    const { doc, page } = await pageWith("BT /F1 12 Tf 0 Tz 50 250 Td (Secreto) Tj ET\n");
    expect(await redact(doc, page)).toMatchObject({ done: true, glyphs: 7 });
  });

  it("gives up on content it cannot read", async () => {
    const { doc, page } = await pageWith("");
    page.node.set(PDFName.of("Contents"), doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: "JBIG2Decode" }), new Uint8Array([1]))));
    expect(await redact(doc, page)).toEqual({ done: false, reason: "unreadable" });
  });

  it("gives up when the cut content cannot be rewritten", async () => {
    const { doc, page } = await pageWith("BT /F1 12 Tf 50 250 Td (Secreto) Tj ET\n");
    vi.mocked(applyNativeSpecs).mockResolvedValueOnce({ failed: ["redaction"] } as never);
    expect(await redact(doc, page)).toEqual({ done: false, reason: "unreadable" });
  });

  it("only removes annotations when no content is under the box, with their pop-ups", async () => {
    const { doc, page } = await pageWith("BT /F1 12 Tf 50 350 Td (Publico) Tj ET\n");
    const { context } = doc;
    const note = context.obj({ Type: "Annot", Subtype: "Text", Rect: [50, 200, 70, 220] });
    const noteRef = context.register(note);
    const popup = context.obj({ Type: "Annot", Subtype: "Popup", Rect: [250, 300, 350, 380], Parent: noteRef });
    const popupRef = context.register(popup);
    note.set(PDFName.of("Popup"), popupRef);
    page.node.set(PDFName.of("Annots"), context.register(context.obj([noteRef, popupRef])));
    expect(await redact(doc, page)).toMatchObject({ done: true, glyphs: 0, annotations: 1 });
    expect(page.node.get(PDFName.of("Annots"))).toBeUndefined();
  });

  it("keeps entries it cannot read and annotations without a usable rectangle", async () => {
    const { doc, page } = await pageWith("");
    const { context } = doc;
    const link = context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 200, 70, 220] }));
    const noSubtype = context.register(context.obj({ Type: "Annot", Rect: [50, 200, 70, 220] }));
    const withPopupValue = context.register(context.obj({ Type: "Annot", Subtype: "Text", Rect: [60, 200, 80, 220], Popup: 3 }));
    const kept = [
      context.register(context.obj({ Type: "Annot", Subtype: "Link" })),
      context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [1, 2] })),
      context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [PDFNumber.of(Number.NaN), 0, 1, 1] })),
      context.register(context.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 300, 310, 310], Parent: 7 })),
    ];
    // A pop-up whose note stays, stays too.
    kept.push(context.register(context.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 300, 310, 310], Parent: kept[0] })));
    page.node.set(PDFName.of("Annots"), context.obj([PDFNumber.of(4), link, noSubtype, withPopupValue, ...kept]));
    expect(await redact(doc, page)).toMatchObject({ done: true, annotations: 3 });
    expect(page.node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(1 + kept.length);
  });

  it("works on pages without annotations", async () => {
    const { doc, page } = await pageWith("BT /F1 12 Tf 50 250 Td (Secreto) Tj ET\n");
    expect(await redact(doc, page)).toMatchObject({ done: true, annotations: 0 });
  });
});
