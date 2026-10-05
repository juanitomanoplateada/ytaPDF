import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeRotation, rotateAnnotations } from "./annotationTransforms";
import type { PageAnnotations } from "./editor.svelte";
import { makeBlankPdf } from "./blankPdf";
import { pathToSvg } from "./geometry";
import { combineStrokes } from "./signatures";

const page = (objects: Record<string, unknown>[]): PageAnnotations => ({ version: "7", objects });

describe("rotateAnnotations", () => {
  const data = page([{ type: "IText", left: 100, top: 50, angle: 0 }]);

  it("keeps objects on the same spot of the content for each quarter turn", () => {
    // A 600×400 page: (100, 50) is near its top-left corner.
    expect(rotateAnnotations(data, 600, 400, 90).objects[0]).toMatchObject({ left: 350, top: 100, angle: 90 });
    expect(rotateAnnotations(data, 600, 400, 180).objects[0]).toMatchObject({ left: 500, top: 350, angle: 180 });
    expect(rotateAnnotations(data, 600, 400, 270).objects[0]).toMatchObject({ left: 50, top: 500, angle: 270 });
  });

  it("returns to the start after a full turn", () => {
    let current = page([{ left: 123, top: 45, angle: 30, flipX: true }]);
    let [w, h] = [600, 400];
    for (let i = 0; i < 4; i++) {
      current = rotateAnnotations(current, w, h, 90);
      [w, h] = [h, w];
    }
    expect(current.objects[0]).toMatchObject({ left: 123, top: 45, angle: 30, flipX: true });
  });

  it("normalises rotations to quarter turns", () => {
    expect([-90, 0, 90, 360, 450, 539].map(normalizeRotation)).toEqual([270, 0, 90, 0, 90, 180]);
  });
});

describe("signature strokes", () => {
  it("joins strokes into one path starting at the origin", () => {
    const result = combineStrokes(
      [
        [
          ["M", 50, 60],
          ["Q", 55, 65, 60, 70],
        ],
        [
          ["M", 80, 60],
          ["L", 90, 75],
        ],
      ],
      { left: 50, top: 60, width: 40, height: 15 },
      2,
    );
    expect(result).toEqual({ path: "M 2 2 Q 7 7 12 12 M 32 2 L 42 17", width: 44, height: 19 });
  });

  it("maps every point of a path", () => {
    const d = pathToSvg(
      [
        ["M", 1, 2],
        ["C", 3, 4, 5, 6, 7, 8],
        ["Z"],
      ],
      (x, y) => [x * 10, y + 1],
    );
    expect(d).toBe("M 10 3 C 30 5 50 7 70 9 Z");
  });
});

describe("makeBlankPdf", () => {
  it("creates a valid page of the requested size", async () => {
    const bytes = makeBlankPdf(842, 595.28);
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    expect([viewport.width, viewport.height]).toEqual([842, 595.28]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
