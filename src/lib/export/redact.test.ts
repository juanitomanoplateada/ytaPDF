import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFStream, StandardFonts, type PDFPage } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ApplyResources } from "../pdfText/apply";
import { FontCache } from "../pdfText/fonts";
import { pageContentBytes } from "../pdfText/interpreter";
import { clipConvex, insideConvex, overlapArea, polygonArea, type Point } from "../polygon";
import { removeUnreachableObjects } from "./assemble";
import { redactPage } from "./redact";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

const noFallback: ApplyResources = {
  fallbackFont: async () => {
    throw new Error("La censura no dibuja texto");
  },
};

/** A box covering the line "Secreto" (baseline 250) and the shapes drawn near y = 200, but not "Publico". */
const BOX: Point[] = [
  [40, 190],
  [200, 190],
  [200, 265],
  [40, 265],
];

async function pageWith(
  content: string,
  extra?: (doc: PDFDocument, page: PDFPage) => void,
): Promise<{ doc: PDFDocument; page: PDFPage }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const image = doc.context.register(
    doc.context.stream(Uint8Array.of(0), {
      Type: "XObject",
      Subtype: "Image",
      Width: 1,
      Height: 1,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
    }),
  );
  page.node.set(
    PDFName.of("Resources"),
    doc.context.obj({ Font: doc.context.obj({ F1: helvetica.ref }), XObject: doc.context.obj({ Im1: image }) }),
  );
  extra?.(doc, page);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
  // Reload, as the export does with real files.
  const loaded = await PDFDocument.load(await doc.save());
  return { doc: loaded, page: loaded.getPage(0) };
}

async function texts(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  return items.map((item) => ("str" in item ? item.str : "")).join(" ");
}

function imageCount(doc: PDFDocument): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") count++;
  }
  return count;
}

const TEXT = "BT /F1 12 Tf 50 300 Td (Publico) Tj ET\nBT /F1 12 Tf 50 250 Td (Secreto) Tj ET\n";

describe("polygons", () => {
  const square = (x: number, y: number, size: number): Point[] => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];

  it("measures the overlap of two squares whatever their orientation", () => {
    expect(overlapArea(square(0, 0, 10), square(5, 5, 10))).toBeCloseTo(25);
    expect(overlapArea(square(0, 0, 10), [...square(5, 5, 10)].reverse())).toBeCloseTo(25);
    expect(overlapArea(square(0, 0, 10), square(20, 20, 5))).toBe(0);
    expect(polygonArea(clipConvex(square(0, 0, 10), square(-5, -5, 30)))).toBeCloseTo(100);
  });

  it("tells points inside a rotated box, with a tolerance", () => {
    const diamond: Point[] = [
      [0, -10],
      [10, 0],
      [0, 10],
      [-10, 0],
    ];
    expect(insideConvex([0, 0], diamond)).toBe(true);
    expect(insideConvex([8, 8], diamond)).toBe(false);
    expect(insideConvex([5.3, 5.3], diamond)).toBe(false);
    expect(insideConvex([5.3, 5.3], diamond, 1)).toBe(true);
  });
});

describe("redactPage", () => {
  it("removes the text, shapes and images under the box and keeps the rest", async () => {
    const { doc, page } = await pageWith(
      `${TEXT}q 0 0 1 rg 60 200 20 10 re f Q\nq 20 0 0 20 100 195 cm /Im1 Do Q\n0 0 400 400 re S\n`,
    );
    const outcome = await redactPage(page, [BOX], new FontCache(doc.context), noFallback);
    expect(outcome).toEqual({ done: true, glyphs: 7, shapes: 1, images: 1, annotations: 0 });

    const content = decoder.decode(pageContentBytes(page).bytes);
    expect(content).not.toContain("Secreto");
    expect(content).toContain("Publico");
    // The page border crosses the box: it stays.
    expect(content).toMatch(/0 0 400 400 re\s+S/);
    expect(content).not.toContain("/Im1 Do");

    removeUnreachableObjects(doc);
    expect(imageCount(doc)).toBe(0);
    const text = await texts(await doc.save());
    expect(text).toContain("Publico");
    expect(text).not.toContain("Secreto");
  });

  it("asks for an image of the page when an image is only partly under the box", async () => {
    const { doc, page } = await pageWith(`${TEXT}q 300 0 0 300 50 50 cm /Im1 Do Q\n`);
    const before = decoder.decode(pageContentBytes(page).bytes);
    const outcome = await redactPage(page, [BOX], new FontCache(doc.context), noFallback);
    expect(outcome).toEqual({ done: false, reason: "image" });
    expect(decoder.decode(pageContentBytes(page).bytes)).toBe(before);
  });

  it("drops the replacement text of marked content that was cut", async () => {
    const { doc, page } = await pageWith(
      "/Span <</ActualText (Secreto) /Lang (es)>> BDC BT /F1 12 Tf 50 250 Td (Secreto) Tj ET EMC\n" +
        "/Span <</ActualText (Publico)>> BDC BT /F1 12 Tf 50 300 Td (Publico) Tj ET EMC\n",
    );
    await redactPage(page, [BOX], new FontCache(doc.context), noFallback);
    const content = decoder.decode(pageContentBytes(page).bytes);
    expect(content).not.toContain("ActualText (Secreto)");
    expect(content).not.toMatch(/ActualText <5365637265746f>/i);
    expect(content).toContain("/Lang");
    expect(content).toContain("(Publico)");
  });

  it("removes links under the box and refuses to cut through form fields", async () => {
    const annotation = (doc: PDFDocument, subtype: string, rect: number[]) =>
      doc.context.register(doc.context.obj({ Type: "Annot", Subtype: subtype, Rect: rect }));

    const linked = await pageWith(TEXT, (doc, page) => {
      page.node.set(
        PDFName.of("Annots"),
        doc.context.obj([annotation(doc, "Link", [50, 245, 100, 260]), annotation(doc, "Link", [50, 295, 100, 310])]),
      );
    });
    const outcome = await redactPage(linked.page, [BOX], new FontCache(linked.doc.context), noFallback);
    expect(outcome).toMatchObject({ done: true, annotations: 1 });
    expect(linked.page.node.Annots()?.size()).toBe(1);

    const withField = await pageWith(TEXT, (doc, page) => {
      page.node.set(PDFName.of("Annots"), doc.context.obj([annotation(doc, "Widget", [50, 245, 100, 260])]));
    });
    expect(await redactPage(withField.page, [BOX], new FontCache(withField.doc.context), noFallback)).toEqual({
      done: false,
      reason: "field",
    });
  });
});

describe("removeUnreachableObjects", () => {
  it("drops objects nothing points to and keeps the document readable", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.context.register(doc.context.obj({ Secret: "yes" }));
    expect(removeUnreachableObjects(doc)).toBe(1);
    const reloaded = await PDFDocument.load(await doc.save());
    expect(reloaded.getPageCount()).toBe(1);
  });
});
