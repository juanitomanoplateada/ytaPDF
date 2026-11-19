import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@cantoo/fontkit";
import { chunkPages, describePages, parsePageRanges, rangeErrorText, sanitizeFileName } from "./pageRanges";
import { extractInk, hexToRgb } from "./signaturePhoto";
import { textToPath, type OutlineFont } from "./typedSignature";
import { crc32, createZip } from "./zip";

describe("parsePageRanges", () => {
  it("turns each comma-separated part into a group of 0-based pages", () => {
    expect(parsePageRanges("1-3, 5, 7-8", 10).groups).toEqual([[0, 1, 2], [4], [6, 7]]);
  });

  it("accepts open ends, spaces, semicolons, dashes and descending ranges", () => {
    expect(parsePageRanges(" 8 - ; -2 ; 4–3 ", 9).groups).toEqual([[7, 8], [0, 1], [3, 2]]);
  });

  it("explains what is wrong", () => {
    expect(rangeErrorText(parsePageRanges("", 5))).toMatch(/al menos una página/);
    expect(rangeErrorText(parsePageRanges("2, x", 5))).toBe("«x» no es una página ni un rango válido.");
    expect(rangeErrorText(parsePageRanges("4-9", 5))).toBe("La página 9 no existe: el documento tiene 5 páginas.");
    expect(rangeErrorText(parsePageRanges("0", 5))).toMatch(/página 0 no existe/);
    expect(rangeErrorText(parsePageRanges("-", 5))).toMatch(/no es una página/);
  });
});

describe("page helpers", () => {
  it("splits pages into groups of a fixed size", () => {
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
    expect(chunkPages(3, 1)).toEqual([[0], [1], [2]]);
    expect(chunkPages(2, 10)).toEqual([[0, 1]]);
  });

  it("describes pages for file names and summaries", () => {
    expect(describePages([2])).toBe("3");
    expect(describePages([0, 1, 2])).toBe("1-3");
    expect(describePages([0, 3, 5])).toBe("1, 4, 6");
  });

  it("cleans file names", () => {
    expect(sanitizeFileName("  Contrato: final/v2.pdf ")).toBe("Contrato_ final_v2");
    expect(sanitizeFileName("foto.PNG", "png")).toBe("foto");
    expect(sanitizeFileName("...")).toBe("");
  });
});

describe("createZip", () => {
  it("computes standard CRC-32 checksums", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("stores each file with its name, size and checksum", () => {
    const files = [
      { name: "página 1.pdf", bytes: new TextEncoder().encode("%PDF-uno") },
      { name: "página 1.pdf", bytes: new TextEncoder().encode("%PDF-dos!") },
    ];
    const zip = createZip(files, new Date(2026, 10, 12, 10, 30, 0));
    const view = new DataView(zip.buffer);
    const decoder = new TextDecoder();

    // End of central directory: two entries.
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);

    // Walk the central directory and read every file back.
    let offset = view.getUint32(end + 16, true);
    const read: { name: string; text: string }[] = [];
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(offset, true)).toBe(0x02014b50);
      expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800);
      const size = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      const data = zip.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
      expect(view.getUint32(offset + 16, true)).toBe(crc32(data));
      read.push({ name, text: decoder.decode(data) });
      offset += 46 + nameLength;
    }
    // Repeated names are made unique.
    expect(read).toEqual([
      { name: "página 1.pdf", text: "%PDF-uno" },
      { name: "página 1 (2).pdf", text: "%PDF-dos!" },
    ]);
  });
});

describe("typed signatures", () => {
  const require = createRequire(import.meta.url);
  const font = fontkit.create(
    new Uint8Array(readFileSync(require.resolve("@expo-google-fonts/dancing-script/600SemiBold/DancingScript_600SemiBold.ttf"))),
  ) as unknown as OutlineFont;

  it("outlines the text as one path whose box starts at the padding", () => {
    const outline = textToPath(font, "Ana Pérez", 64, 4);
    expect(outline).not.toBeNull();
    const { path, width, height } = outline!;
    expect(path.startsWith("M ")).toBe(true);
    expect(path).toMatch(/[QC] /);
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const xs = numbers.filter((_, i) => i % 2 === 0);
    const ys = numbers.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(4, 1);
    expect(Math.min(...ys)).toBeCloseTo(4, 1);
    expect(Math.max(...xs)).toBeCloseTo(width - 4, 1);
    expect(Math.max(...ys)).toBeCloseTo(height - 4, 1);
    // A name is much wider than it is tall.
    expect(width).toBeGreaterThan(height * 2);
  });

  it("returns nothing for text without visible glyphs", () => {
    expect(textToPath(font, "   ")).toBeNull();
  });
});

/** White paper with a dark grey stroke from (20, 10) to (59, 14). */
function photo() {
  const width = 80;
  const height = 30;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 10; y < 15; y++) {
    for (let x = 20; x < 60; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 40;
    }
  }
  return { data, width, height };
}

describe("signature photos", () => {
  it("keeps the ink in one colour on a transparent background, cropped to it", () => {
    const ink = extractInk(photo(), hexToRgb("#1a3a8f"), 0.5);
    expect(ink.found).toBe(true);
    // Cropped to the stroke plus a 1 % margin.
    expect(ink.width).toBe(40 + 2);
    expect(ink.height).toBe(5 + 2);
    const at = (x: number, y: number) => Array.from(ink.data.subarray((y * ink.width + x) * 4, (y * ink.width + x) * 4 + 4));
    expect(at(10, 3)).toEqual([0x1a, 0x3a, 0x8f, 255]);
    expect(at(0, 0)[3]).toBe(0);
  });

  it("reports when there is no ink", () => {
    const blank = { data: new Uint8ClampedArray(20 * 20 * 4).fill(255), width: 20, height: 20 };
    expect(extractInk(blank, hexToRgb("#000000")).found).toBe(false);
  });
});
