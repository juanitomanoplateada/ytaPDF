import { describe, expect, it } from "vitest";
import { degrees, PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import { applyToPoint, type Matrix } from "../geometry";
import { assembleDocument, type ExportSource } from "./assemble";
import { DrawContext, drawOnPage, type TextDrawable } from "./drawing";

async function openWithPdfjs(bytes: Uint8Array, password?: string) {
  return getDocument({ data: bytes.slice(), password, verbosity: 0 }).promise;
}

async function firstPage(bytes: Uint8Array): Promise<PDFPageProxy> {
  return (await openWithPdfjs(bytes)).getPage(1);
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await openWithPdfjs(bytes);
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    texts.push(items.map((item) => ("str" in item ? item.str : "")).join(""));
  }
  return texts;
}

function textAt(matrix: Matrix, text = "Hola"): TextDrawable {
  return {
    kind: "text",
    matrix,
    lines: [{ text, x: 0, baseline: 0 }],
    fontSize: 20,
    color: { r: 0, g: 0, b: 0 },
    opacity: 1,
    underline: false,
  };
}

const noImages = async () => {
  throw new Error("Este test no usa imágenes");
};

/** Draws `drawable` on a fresh copy of `source` and returns where PDF.js sees it. */
async function roundTrip(source: Uint8Array, drawable: TextDrawable) {
  const before = await firstPage(source);
  const doc = await PDFDocument.load(source);
  await drawOnPage(doc.getPage(0), [drawable], before.getViewport({ scale: 1 }).transform, new DrawContext(doc, noImages));
  const after = await firstPage(await doc.save());

  const { items } = await after.getTextContent();
  const item = items.find((i) => "str" in i && i.str === drawable.lines[0].text);
  if (!item || !("transform" in item)) throw new Error("No se encontró el texto exportado");

  // Text matrix in PDF user space → the editor's scene (viewport at scale 1).
  const viewport = after.getViewport({ scale: 1 }).transform;
  const [a, b, , , e, f] = item.transform as number[];
  const origin = applyToPoint(viewport as Matrix, e, f);
  const advance = [viewport[0] * a + viewport[2] * b, viewport[1] * a + viewport[3] * b];
  const length = Math.hypot(advance[0], advance[1]);
  return { origin, direction: [advance[0] / length, advance[1] / length] };
}

async function makePage(rotation: number, withCropBox: boolean) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  if (withCropBox) page.setCropBox(40, 25, 500, 320);
  page.setRotation(degrees(rotation));
  return doc.save();
}

describe("drawOnPage", () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const withCropBox of [false, true]) {
      it(`keeps text where it was placed (rotación ${rotation}°, ${withCropBox ? "con" : "sin"} CropBox)`, async () => {
        const source = await makePage(rotation, withCropBox);
        const { origin, direction } = await roundTrip(source, textAt([1, 0, 0, 1, 120, 90]));
        expect(origin[0]).toBeCloseTo(120, 2);
        expect(origin[1]).toBeCloseTo(90, 2);
        // Glyphs still run left to right on screen.
        expect(direction[0]).toBeCloseTo(1, 6);
        expect(direction[1]).toBeCloseTo(0, 6);
      });
    }
  }

  it("applies the object's rotation like the canvas (clockwise, y down)", async () => {
    const angle = (30 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const source = await makePage(90, true);
    const { origin, direction } = await roundTrip(source, textAt([cos, sin, -sin, cos, 150, 200]));
    expect(origin[0]).toBeCloseTo(150, 2);
    expect(origin[1]).toBeCloseTo(200, 2);
    expect(direction[0]).toBeCloseTo(cos, 6);
    expect(direction[1]).toBeCloseTo(sin, 6);
  });

  it("mirrors horizontally flipped objects", async () => {
    const source = await makePage(0, false);
    const { direction } = await roundTrip(source, textAt([-1, 0, 0, 1, 300, 200]));
    expect(direction[0]).toBeCloseTo(-1, 6);
  });

  it("replaces characters the standard fonts cannot encode instead of failing", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const context = new DrawContext(doc, noImages);
    const vt = (await firstPage(await doc.save())).getViewport({ scale: 1 }).transform;
    await drawOnPage(doc.getPage(0), [textAt([1, 0, 0, 1, 50, 50], "Hola 😀")], vt, context);
    expect([...context.unsupportedChars]).toEqual(["😀"]);
    expect(await pageTexts(await doc.save())).toEqual(["Hola ?"]);
  });

  it("embeds each standard font once", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const context = new DrawContext(doc, noImages);
    const vt = (await firstPage(await doc.save())).getViewport({ scale: 1 }).transform;
    const texts = [1, 2, 3].map((i) => textAt([1, 0, 0, 1, 50, 50 * i], `Línea ${i}`));
    await drawOnPage(doc.getPage(0), texts, vt, context);
    // pdf-lib adds a resource name per drawText call; all must share one font.
    const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    const fontObjects = new Set(fonts?.values().map((ref) => ref.toString()));
    expect(fontObjects.size).toBe(1);
  });
});

describe("PDF.js", () => {
  it("keeps page counts per document when several are open", async () => {
    // pdfjs-dist 5.4 shared one page counter between documents, so opening a
    // one-page PDF made pages 2+ of earlier documents unreachable.
    const three = await openWithPdfjs((await makeSource("a", "A", 3)).bytes);
    const one = await openWithPdfjs((await makeSource("b", "B", 1)).bytes);
    expect(one.numPages).toBe(1);
    await expect(three.getPage(3)).resolves.toBeTruthy();
  });
});

async function makeSource(
  id: string,
  label: string,
  pages: number,
  options: { field?: boolean; userPassword?: string; encrypt?: boolean } = {},
): Promise<ExportSource> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([300, 200]).drawText(`${label}${i}`, { x: 20, y: 100, size: 14, font });
  }
  if (options.field) {
    const field = doc.getForm().createTextField(`campo${label}`);
    field.setText("valor");
    field.addToPage(doc.getPage(0), { x: 20, y: 20, width: 120, height: 24 });
  }
  if (options.encrypt) {
    doc.encrypt({ ownerPassword: "propietario", userPassword: options.userPassword ?? "" });
  }
  const bytes = await doc.save();
  return { id, bytes, pageCount: pages, password: options.userPassword };
}

describe("assembleDocument", () => {
  it("edits the original in place when the page order is unchanged", async () => {
    const a = await makeSource("a", "A", 3, { field: true });
    const { doc, inPlace } = await assembleDocument(
      [0, 1, 2].map((i) => ({ sourceId: "a", sourceIndex: i })),
      new Map([["a", a]]),
    );
    expect(inPlace).toBe(true);
    expect(doc.getForm().getFields().map((f) => f.getName())).toEqual(["campoA"]);
  });

  it("reorders, drops and merges pages without carrying deleted pages", async () => {
    const a = await makeSource("a", "A", 4, { field: true });
    const b = await makeSource("b", "B", 2);
    const { doc, inPlace } = await assembleDocument(
      [
        { sourceId: "a", sourceIndex: 2 },
        { sourceId: "b", sourceIndex: 1 },
        { sourceId: "a", sourceIndex: 0 },
      ],
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    expect(inPlace).toBe(false);
    const bytes = await doc.save();
    expect(await pageTexts(bytes)).toEqual(["A2", "B1", "A0"]);
    // The form field on the copied page is still a working field.
    const fields = await (await openWithPdfjs(bytes)).getFieldObjects();
    expect([...(fields?.keys() ?? [])]).toEqual(["campoA"]);
  });

  it("decrypts protected documents so their content survives", async () => {
    const ownerOnly = await makeSource("o", "O", 1, { encrypt: true });
    const withPassword = await makeSource("p", "P", 1, { encrypt: true, userPassword: "secreto" });
    const { doc } = await assembleDocument(
      [
        { sourceId: "o", sourceIndex: 0 },
        { sourceId: "p", sourceIndex: 0 },
      ],
      new Map([
        ["o", ownerOnly],
        ["p", withPassword],
      ]),
    );
    expect(await pageTexts(await doc.save())).toEqual(["O0", "P0"]);
  });

  it("removes the protection when exporting a single encrypted document", async () => {
    const source = await makeSource("p", "P", 2, { encrypt: true, userPassword: "secreto" });
    const { doc, inPlace } = await assembleDocument(
      [0, 1].map((i) => ({ sourceId: "p", sourceIndex: i })),
      new Map([["p", source]]),
    );
    expect(inPlace).toBe(true);
    expect(await pageTexts(await doc.save())).toEqual(["P0", "P1"]);
  });
});
