import { createCanvas } from "canvas";
import { PDFContentStream, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFString } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { alignShifts, distributeShifts } from "./arrange";
import { imagesToPdf } from "./imagePdf";
import { ocrMatchQuads, ocrStamp, ocrTextItems, quadDirection, toSceneQuad, withOcrText, type OcrPage } from "./ocrText";
import { centroid, clipConvex, insideConvex, overlapArea, type Point } from "./polygon";
import { colorToHex, colorToRgb, hexToColor } from "./pdfText/color";
import { dictOf, nameOf, numbersOf, objectId, streamBytes, stringBytes } from "./pdfText/pdfObjects";
import { extractInk, hexToRgb, paperLevel } from "./signaturePhoto";

describe("fill colours", () => {
  it("converts each device space to RGB, clamping components", () => {
    expect(colorToRgb({ space: "gray", components: [0.5] })).toEqual([0.5, 0.5, 0.5]);
    expect(colorToRgb({ space: "rgb", components: [2, -1, 0.25] })).toEqual([1, 0, 0.25]);
    expect(colorToRgb({ space: "cmyk", components: [1, 0, 0, 0] })).toEqual([0, 1, 1]);
  });

  it("writes and reads hex colours", () => {
    expect(colorToHex({ space: "rgb", components: [1, 0, 0.5] })).toBe("#ff0080");
    expect(hexToColor(" #FF0080 ")).toEqual({ space: "rgb", components: [1, 0, 128 / 255] });
    expect(hexToColor("rojo")).toEqual({ space: "gray", components: [0] });
  });
});

describe("pdf object helpers", () => {
  it("reads names, dictionaries, numbers and strings, or nothing for other objects", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const stream = context.flateStream("abc", { Type: "XObject" });
    const ref = context.register(PDFName.of("Nombre"));
    expect(nameOf(context, ref)).toBe("Nombre");
    expect(nameOf(context, PDFNumber.of(1))).toBeUndefined();
    expect(dictOf(context, stream)?.get(PDFName.of("Type"))).toEqual(PDFName.of("XObject"));
    expect(dictOf(context, PDFNumber.of(1))).toBeUndefined();
    expect(numbersOf(context, context.obj([1, "x", 3]))).toEqual([1, 0, 3]);
    expect(numbersOf(context, PDFNumber.of(1))).toBeUndefined();
    expect(stringBytes(context, PDFString.of("ab"))).toEqual(new Uint8Array([97, 98]));
    expect(stringBytes(context, PDFHexString.of("6162"))).toEqual(new Uint8Array([97, 98]));
    expect(stringBytes(context, PDFNumber.of(1))).toBeUndefined();
    expect(objectId(ref, "x")).toBe(ref.toString());
    expect(objectId(PDFNumber.of(1), "x")).toBe("x");
  });

  it("decodes the streams it can and gives up on unknown filters", async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const content = PDFContentStream.of(context.obj({}), [], false);
    expect(streamBytes(content)).toEqual(new Uint8Array());
    class PlainStream extends PDFStream {
      getContents() {
        return new Uint8Array([7]);
      }
    }
    expect(streamBytes(new PlainStream(context.obj({})))).toEqual(new Uint8Array([7]));
    const unknown = PDFRawStream.of(context.obj({ Filter: "JBIG2Decode" }), new Uint8Array([1, 2, 3]));
    expect(streamBytes(unknown)).toBeUndefined();
  });
});

describe("polygons", () => {
  const square: Point[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("clips against degenerate clip polygons as if they were counter-clockwise", () => {
    const line: Point[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    expect(clipConvex(square, line).length).toBeGreaterThanOrEqual(0);
    expect(overlapArea(square, line)).toBe(0);
    expect(overlapArea([[0, 0]], square)).toBe(0);
  });

  it("tells points inside from points outside, ignoring repeated corners", () => {
    const withRepeat: Point[] = [[0, 0], [0, 0], [10, 0], [10, 10], [0, 10]];
    expect(insideConvex([5, 5], withRepeat)).toBe(true);
    expect(insideConvex([15, 5], withRepeat)).toBe(false);
    expect(insideConvex([10.5, 5], withRepeat, 1)).toBe(true);
    const flat: Point[] = [[0, 0], [10, 0], [20, 0]];
    expect(insideConvex([5, 0], flat)).toBe(true);
  });

  it("finds the centre of the corners, and the origin for no corners", () => {
    expect(centroid(square)).toEqual([5, 5]);
    expect(centroid([])).toEqual([0, 0]);
  });
});

describe("recognised text", () => {
  const word = (text: string, x0: number, x1: number) => ({
    text,
    quad: [[x0, 0], [x1, 0], [x1, 10], [x0, 10]] as Point[],
  });
  const page: OcrPage = {
    languages: "spa",
    lines: [
      { quad: [[0, 0], [100, 0], [100, 10], [0, 10]], words: [word("hola", 0, 40), word("mundo", 50, 100)] },
      { quad: [[0, 20], [100, 20], [100, 30], [0, 30]], words: [] },
    ],
  };

  it("finds matches only where there are words and the match has length", () => {
    expect(ocrMatchQuads(undefined, "hola")).toEqual([]);
    expect(ocrMatchQuads(page, "hola")).toHaveLength(1);
    const backwards: OcrPage = {
      languages: "spa",
      lines: [{ quad: [[0, 0], [100, 0], [100, 10], [0, 10]], words: [word("x", 40, 0)] }],
    };
    expect(ocrMatchQuads(backwards, "x")).toEqual([]);
  });

  it("uses a unit direction even for collapsed quads", () => {
    expect(quadDirection([[3, 3], [3, 3], [3, 3], [3, 3]])).toEqual([0, 0]);
  });

  it("skips words without area and leaves pages without text alone", () => {
    const flat: OcrPage = { languages: "spa", lines: [{ quad: page.lines[0].quad, words: [word("x", 5, 5)] }] };
    expect(ocrTextItems(flat)).toEqual([]);
    const content = { items: [], styles: {} };
    expect(withOcrText(content, undefined)).toBe(content);
    expect(withOcrText(content, { languages: "spa", lines: [] })).toBe(content);
    expect(withOcrText(content, page).items).toHaveLength(2);
  });

  it("maps quads to the scene and stamps pages", () => {
    expect(toSceneQuad([[1, 2]], [2, 0, 0, 2, 10, 10])).toEqual([[12, 14]]);
    expect(ocrStamp(page)).toBe("spa:2:2");
    expect(ocrStamp(undefined)).toBe("");
  });
});

describe("arranging", () => {
  const boxes = [
    { left: 0, top: 0, width: 10, height: 10 },
    { left: 30, top: 50, width: 10, height: 20 },
    { left: 100, top: 100, width: 10, height: 10 },
  ];

  it("aligns to the top and bottom edges", () => {
    expect(alignShifts(boxes, "top").map((s) => s.dy)).toEqual([0, -50, -100]);
    expect(alignShifts(boxes, "bottom").map((s) => s.dy)).toEqual([100, 40, 0]);
  });

  it("distributes vertically", () => {
    const shifts = distributeShifts(boxes, "vertical");
    expect(shifts.every((s) => s.dx === 0)).toBe(true);
    expect(shifts[1].dy).toBe(-5);
    expect(distributeShifts(boxes.slice(0, 2), "vertical")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });
});

describe("pages from images", () => {
  it("embeds PNG and JPEG images and sets the title when given", async () => {
    const canvas = createCanvas(20, 10);
    canvas.getContext("2d").fillRect(0, 0, 5, 5);
    const bytes = await imagesToPdf(
      [
        { url: "a", mime: "image/png", bytes: new Uint8Array(canvas.toBuffer("image/png")) },
        { url: "b", mime: "image/jpeg", bytes: new Uint8Array(canvas.toBuffer("image/jpeg")) },
      ] as never,
      "Fotos",
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe("Fotos");
    const untitled = await PDFDocument.load(await imagesToPdf([]));
    expect(untitled.getTitle()).toBeUndefined();
  });
});

describe("signature photos", () => {
  const image = (pixels: [number, number][]) => {
    // A 10×1 strip of white paper with some grey or translucent pixels.
    const data = new Uint8ClampedArray(10 * 4).fill(255);
    for (const [x, value] of pixels) data.set([value, value, value, 255], x * 4);
    return { data, width: 10, height: 1 };
  };

  it("fades pixels between ink and paper and drops nearly invisible ones", () => {
    const ink = extractInk(image([[2, 0], [5, 150], [8, 190]]), { r: 0, g: 0, b: 0 }, 0.5);
    expect(ink.found).toBe(true);
    // The faint pixel is kept in the image but does not widen the crop.
    expect(ink.width).toBe(5 - 2 + 1);
    const alphas = Array.from({ length: ink.width }, (_, x) => ink.data[x * 4 + 3]);
    expect(alphas[0]).toBe(255);
    expect(alphas[3]).toBeGreaterThan(24);
    expect(alphas[3]).toBeLessThan(255);
  });

  it("takes the lightest level as the paper of a white image", () => {
    expect(paperLevel(image([]))).toBe(255);
    expect(paperLevel({ data: new Uint8ClampedArray(), width: 0, height: 0 })).toBe(0);
  });

  it("reads hex colours, falling back to black", () => {
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("verde")).toEqual({ r: 0, g: 0, b: 0 });
  });
});
