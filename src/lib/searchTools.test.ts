import { describe, expect, it } from "vitest";
import { chunkText } from "./localAi";
import { ocrMatchQuads, ocrTextItems, withOcrText, type OcrPage } from "./ocrText";
import { toOcrLines } from "./ocr";
import type { PageTextAnalysis, TextUnit } from "./pdfText/types";
import { redactionBox, redactionBoxesFor } from "./textReplace";
import { findInString } from "./textSearch";

describe("findInString", () => {
  it("matches like the search: without case or accents, with indices in the original text", () => {
    const text = "Canción: la CANCION y la cancion";
    expect(findInString(text, "cancion")).toEqual([
      { start: 0, end: 7 },
      { start: 12, end: 19 },
      { start: 25, end: 32 },
    ]);
    expect(findInString("Juan  Pérez", "juan perez")).toEqual([{ start: 0, end: 11 }]);
    expect(findInString("nada", "  ")).toEqual([]);
  });
});

/** A one-line unit "Hola Juan" on a 600×800 page, baseline at y = 700, 10 points per character. */
function unit(): TextUnit {
  const chars = Array.from("Hola Juan", (text, i) => ({
    text,
    font: 0,
    size: 12,
    color: { space: "gray" as const, components: [0] },
    rise: 0,
    x0: i * 10,
    x1: i * 10 + (text === " " ? 0 : 10),
  }));
  return {
    id: "l:0:0",
    kind: "line",
    lines: [chars],
    joins: [],
    align: "left",
    justifyLast: false,
    origin: [100, 700],
    u: [1, 0],
    v: [0, 1],
    hScale: 1,
    width: 90,
    naturalWidth: 90,
    leading: 0,
    size: 12,
    erase: ["0:0-8"],
    insertAfter: "end",
    alpha: 1,
    renderMode: 0,
    quads: [
      [
        [100, 697],
        [190, 697],
        [190, 709],
        [100, 709],
      ],
    ],
    editable: true,
  };
}

describe("redaction by search", () => {
  it("covers exactly the characters of each match", () => {
    const analysis: PageTextAnalysis = { fonts: [], lines: [unit()], paragraphs: [], paragraphOf: [0] };
    // User space (y up) → scene (y down) for an 800-point-high page.
    const boxes = redactionBoxesFor(analysis, [1, 0, 0, -1, 0, 800], "juan");
    expect(boxes).toHaveLength(1);
    const [box] = boxes as { left: number; top: number; width: number; height: number; ytaKind: string; fill: string }[];
    expect(box.ytaKind).toBe("redact");
    expect(box.fill).toBe("#000000");
    // "Juan" goes from x = 150 to 190 and from y = 697 to 709 (scene 91 to 103), plus a 1-point margin.
    expect(box.left).toBeCloseTo(170);
    expect(box.top).toBeCloseTo(97);
    expect(box.width).toBeCloseTo(42);
    expect(box.height).toBeCloseTo(14);
  });

  it("turns rotated text into a rotated box", () => {
    const box = redactionBox([
      [0, 0],
      [0, -40],
      [10, -40],
      [10, 0],
    ]) as { angle: number; width: number; height: number };
    expect(box.angle).toBeCloseTo(-90);
    expect(box.width).toBeCloseTo(42);
    expect(box.height).toBeCloseTo(12);
  });
});

describe("OCR text", () => {
  // Tesseract boxes on a page rendered at scale 2 (pixels, y down) → user space.
  const toUser: [number, number, number, number, number, number] = [0.5, 0, 0, -0.5, 0, 800];
  const page: OcrPage = {
    languages: "spa",
    lines: toOcrLines(
      [
        {
          paragraphs: [
            {
              lines: [
                {
                  bbox: { x0: 100, y0: 100, x1: 400, y1: 140 },
                  words: [
                    { text: "Factura", confidence: 92, bbox: { x0: 100, y0: 100, x1: 240, y1: 140 } },
                    { text: "§§", confidence: 12, bbox: { x0: 250, y0: 100, x1: 270, y1: 140 } },
                    { text: "Número", confidence: 88, bbox: { x0: 280, y0: 100, x1: 400, y1: 140 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
      toUser,
    ),
  };

  it("keeps confident words, placed in the page's user space", () => {
    expect(page.lines[0].words.map((word) => word.text)).toEqual(["Factura", "Número"]);
    // Bottom-left of "Factura": pixel (100, 140) → (50, 730).
    expect(page.lines[0].words[0].quad[0]).toEqual([50, 730]);
  });

  it("finds matches across the line's words", () => {
    const [quad] = ocrMatchQuads(page, "factura numero");
    expect(quad[0][0]).toBeCloseTo(50);
    expect(quad[1][0]).toBeCloseTo(200);
  });

  it("adds the words to the page's text content for the text layer and the search", () => {
    const items = ocrTextItems(page);
    expect(items.map((item) => item.str)).toEqual(["Factura ", "Número"]);
    expect(items[1].hasEOL).toBe(true);
    const merged = withOcrText({ items: [{ str: "x" }], styles: {} }, page);
    expect(merged.items).toHaveLength(3);
    expect(Object.keys(merged.styles)).toEqual(["ytaOCR"]);
  });
});

describe("chunkText", () => {
  it("splits at paragraphs and sentences without losing text", () => {
    const text = "Primer párrafo corto.\n\nSegundo párrafo. Tiene dos frases largas de verdad.\n\nTercero.";
    const chunks = chunkText(text, 40);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(chunkText("uno\n\ndos", 100)).toEqual(["uno\n\ndos"]);
  });
});
