import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@cantoo/fontkit";
import { degrees, PDFDict, PDFDocument, PDFName, StandardFonts, type PDFPage } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import { applyToPoint, IDENTITY, multiply, type Matrix } from "../geometry";
import { assembleDocument, type ExportSource } from "./assemble";
import {
  DrawContext,
  drawOnPage,
  type Drawable,
  type DrawResources,
  type FontkitLike,
  type TextDrawable,
} from "./drawing";

const require = createRequire(import.meta.url);
const NOTO_SANS = new Uint8Array(
  readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")),
);

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

const noImages: DrawResources = {
  loadImage: async () => {
    throw new Error("Este test no usa imágenes");
  },
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

interface Operator {
  name: string;
  args: { asNumber?: () => number }[];
}

/**
 * Replays the operators drawn on a page (q/Q, cm and path construction) and
 * returns every path point in PDF user space.
 */
function tracePoints(page: PDFPage): [number, number][] {
  const operators = (page as unknown as { getContentStream(): { operators: Operator[] } }).getContentStream().operators;
  let ctm: Matrix = [...IDENTITY];
  const stack: Matrix[] = [];
  const points: [number, number][] = [];
  for (const { name, args } of operators) {
    const n = args.map((arg) => (typeof arg?.asNumber === "function" ? arg.asNumber() : Number.NaN));
    if (name === "q") stack.push(ctm);
    else if (name === "Q") ctm = stack.pop() ?? [...IDENTITY];
    else if (name === "cm") ctm = multiply(ctm, n as Matrix);
    else if (name === "m" || name === "l") points.push(applyToPoint(ctm, n[0], n[1]));
    else if (name === "c") points.push(applyToPoint(ctm, n[4], n[5]));
  }
  return points;
}

/** Draws on a copy of `source` and returns the path points in the editor's scene. */
async function scenePoints(source: Uint8Array, drawable: Drawable) {
  const viewport = (await firstPage(source)).getViewport({ scale: 1 }).transform as Matrix;
  const doc = await PDFDocument.load(source);
  const page = doc.getPage(0);
  await drawOnPage(page, [drawable], viewport, new DrawContext(doc, noImages));
  return tracePoints(page).map(([x, y]) => applyToPoint(viewport, x, y));
}

function expectPoints(actual: [number, number][], expected: [number, number][]) {
  const key = ([x, y]: [number, number]) => `${x.toFixed(2)},${y.toFixed(2)}`;
  expect(new Set(actual.map(key))).toEqual(new Set(expected.map(key)));
}

const stroke = { stroke: { r: 1, g: 0, b: 0 }, strokeWidth: 2, fill: null, opacity: 1 };

describe("vector shapes", () => {
  it("places a line drawn in page space, on a rotated and cropped page", async () => {
    const source = await makePage(90, true);
    const points = await scenePoints(source, {
      kind: "path",
      matrix: IDENTITY,
      d: "M 100 120 L 300 220",
      lineCap: "round",
      lineJoin: "round",
      ...stroke,
    });
    expectPoints(points, [
      [100, 120],
      [300, 220],
    ]);
  });

  it("applies the object's transform to a signature path", async () => {
    const angle = Math.PI / 6;
    const matrix = multiply(
      [1, 0, 0, 1, 200, 300],
      multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0], [2, 0, 0, 2, 0, 0]),
    );
    const source = await makePage(270, true);
    const points = await scenePoints(source, {
      kind: "path",
      matrix,
      d: "M -10 -5 L 10 5",
      lineCap: "round",
      lineJoin: "round",
      ...stroke,
    });
    expectPoints(points, [applyToPoint(matrix, -10, -5), applyToPoint(matrix, 10, 5)]);
  });

  it("draws rectangles centred on the object", async () => {
    const source = await makePage(180, false);
    const points = await scenePoints(source, {
      kind: "rect",
      matrix: [1, 0, 0, 1, 150, 100],
      width: 80,
      height: 40,
      ...stroke,
    });
    expectPoints(points, [
      [110, 80],
      [110, 120],
      [190, 120],
      [190, 80],
    ]);
  });

  it("draws ellipses through their four extreme points", async () => {
    const source = await makePage(0, true);
    const points = await scenePoints(source, {
      kind: "ellipse",
      matrix: [1, 0, 0, 1, 300, 200],
      rx: 50,
      ry: 20,
      ...stroke,
    });
    expectPoints(points, [
      [250, 200],
      [300, 180],
      [350, 200],
      [300, 220],
    ]);
  });
});

describe("embedded fonts", () => {
  const resources: DrawResources = {
    ...noImages,
    loadFont: async () => NOTO_SANS,
    fontkit: fontkit as unknown as FontkitLike,
  };

  it("writes scripts the standard fonts cannot encode", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const context = new DrawContext(doc, resources);
    const vt = (await firstPage(await doc.save())).getViewport({ scale: 1 }).transform;
    const text = { ...textAt([1, 0, 0, 1, 40, 80], "Привет κόσμε, ñandú"), fontFamily: '"Noto Sans", sans-serif' };
    await drawOnPage(doc.getPage(0), [text], vt, context);
    expect(context.missingGlyphs.size).toBe(0);
    expect((await pageTexts(await doc.save()))[0].replace(/\s+/g, " ")).toBe("Привет κόσμε, ñandú");
  });

  it("reports glyphs missing from the embedded font", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const context = new DrawContext(doc, resources);
    const vt = (await firstPage(await doc.save())).getViewport({ scale: 1 }).transform;
    const text = { ...textAt([1, 0, 0, 1, 40, 80], "Hola 😀"), fontFamily: '"Noto Sans", sans-serif' };
    await drawOnPage(doc.getPage(0), [text], vt, context);
    expect([...context.missingGlyphs]).toEqual(["😀"]);
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

  it("adds the user's rotation to each page's own", async () => {
    const a = await makeSource("a", "A", 2);
    const inPlace = await assembleDocument(
      [
        { sourceId: "a", sourceIndex: 0, rotation: 90 },
        { sourceId: "a", sourceIndex: 1, rotation: 0 },
      ],
      new Map([["a", a]]),
    );
    expect(inPlace.inPlace).toBe(true);
    expect(inPlace.pages.map((p) => p.getRotation().angle)).toEqual([90, 0]);

    const rotatedDoc = await PDFDocument.load(a.bytes);
    rotatedDoc.getPage(1).setRotation(degrees(90));
    const rotated = { ...a, bytes: await rotatedDoc.save() };
    const copied = await assembleDocument(
      [{ sourceId: "a", sourceIndex: 1, rotation: 270 }],
      new Map([["a", rotated]]),
    );
    expect(copied.pages[0].getRotation().angle).toBe(0);
  });

  it("replaces redacted pages with new, empty pages", async () => {
    const a = await makeSource("a", "A", 2);
    const { doc, pages, inPlace } = await assembleDocument(
      [
        { sourceId: "a", sourceIndex: 0 },
        { kind: "raster", width: 300, height: 200 },
      ],
      new Map([["a", a]]),
    );
    expect(inPlace).toBe(false);
    expect(pages[1].getSize()).toEqual({ width: 300, height: 200 });
    // Nothing of the original page content may remain in the file.
    expect(await pageTexts(await doc.save())).toEqual(["A0", ""]);
  });

  it("fills the document's own form fields", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    form.createTextField("nombre").addToPage(page, { x: 20, y: 340, width: 200, height: 24 });
    form.createTextField("ciudad").addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
    form.createCheckBox("acepto").addToPage(page, { x: 20, y: 260, width: 16, height: 16 });
    const radio = form.createRadioGroup("plan");
    radio.addOptionToPage("basico", page, { x: 20, y: 220, width: 16, height: 16 });
    radio.addOptionToPage("completo", page, { x: 60, y: 220, width: 16, height: 16 });
    const dropdown = form.createDropdown("pais");
    dropdown.addOptions(["Chile", "Colombia", "México"]);
    dropdown.addToPage(page, { x: 20, y: 160, width: 200, height: 24 });
    const source: ExportSource = { id: "f", bytes: await doc.save(), pageCount: 1 };

    const { doc: out, failedFields } = await assembleDocument(
      [{ sourceId: "f", sourceIndex: 0 }],
      new Map([["f", source]]),
      {
        formValues: {
          f: { nombre: "María José", ciudad: "Санкт-Петербург", acepto: true, plan: "completo", pais: "México" },
        },
        fieldFont: async (target) => {
          target.registerFontkit(fontkit as never);
          return target.embedFont(NOTO_SANS, { subset: true });
        },
      },
    );
    expect(failedFields).toEqual([]);
    const fields = await (await openWithPdfjs(await out.save())).getFieldObjects();
    // Each field lists its parent first, then the widgets that hold the value.
    const value = (name: string) =>
      (fields?.get(name) as { type: string; value?: unknown }[] | undefined)?.find((w) => w.type)?.value;
    expect(value("nombre")).toBe("María José");
    expect(value("ciudad")).toBe("Санкт-Петербург");
    expect(value("acepto")).not.toBe("Off");
    expect(value("plan")).toBe("completo");
    expect(value("pais")).toBe("México");
  });
});
