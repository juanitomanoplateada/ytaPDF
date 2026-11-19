import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { FontCache } from "../pdfText/fonts";
import { parseLinkInput } from "../links";
import { compressImages, isRecodableJpeg, type RecodeRequest } from "./compress";
import { addPageAnnotations } from "./pdfAnnotations";

const encoder = new TextEncoder();

/** A page drawing a fake 400×300 JPEG at `shown` points wide (the decoder is never run). */
async function pageWithJpeg(shown: number, extra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 600]);
  const jpeg = new Uint8Array(20000).fill(7);
  const image = doc.context.register(
    doc.context.stream(jpeg, {
      Type: "XObject",
      Subtype: "Image",
      Width: 400,
      Height: 300,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "DCTDecode",
      ...extra,
    }),
  );
  page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: doc.context.obj({ Im1: image }) }));
  const content = `q ${shown} 0 0 ${(shown * 3) / 4} 10 10 cm /Im1 Do Q`;
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(encoder.encode(content))));
  return { doc, page, image };
}

describe("compressImages", () => {
  it("re-encodes JPEGs and scales down those shown much smaller than they are", async () => {
    const { doc, page, image } = await pageWithJpeg(72);
    const requests: RecodeRequest[] = [];
    const report = await compressImages(doc, [page], new FontCache(doc.context), { quality: 0.7, maxDpi: 150 }, async (request) => {
      requests.push(request);
      return new Uint8Array(1000);
    });
    expect(report).toEqual({ images: 1, before: 20000, after: 1000 });
    // Shown one inch wide at 150 ppp: 150 pixels are enough.
    expect(requests[0]).toMatchObject({ width: 400, height: 300, targetWidth: 150, targetHeight: 113, quality: 0.7 });
    const replaced = doc.context.lookup(image) as PDFRawStream;
    expect(replaced.getContents().length).toBe(1000);
    expect(replaced.dict.get(PDFName.of("Width"))?.toString()).toBe("150");
    expect(replaced.dict.get(PDFName.of("Filter"))?.toString()).toBe("/DCTDecode");
  });

  it("keeps the original when re-encoding does not save enough", async () => {
    const { doc, page, image } = await pageWithJpeg(400);
    const report = await compressImages(doc, [page], new FontCache(doc.context), { quality: 0.9, maxDpi: 300 }, async () => new Uint8Array(19000));
    expect(report.images).toBe(0);
    expect((doc.context.lookup(image) as PDFRawStream).getContents().length).toBe(20000);
  });

  it("leaves alone images whose colours a browser could change", async () => {
    const cmyk = await pageWithJpeg(72, { ColorSpace: "DeviceCMYK" });
    expect(isRecodableJpeg(cmyk.doc.context.lookup(cmyk.image) as PDFRawStream)).toBe(false);
    const decoded = await pageWithJpeg(72, { Decode: [1, 0, 1, 0, 1, 0] });
    expect(isRecodableJpeg(decoded.doc.context.lookup(decoded.image) as PDFRawStream)).toBe(false);
    const plain = await pageWithJpeg(72);
    expect(isRecodableJpeg(plain.doc.context.lookup(plain.image) as PDFRawStream)).toBe(true);
  });
});

describe("addPageAnnotations", () => {
  it("writes notes and links that PDF.js reads as annotations", async () => {
    const doc = await PDFDocument.create();
    const first = doc.addPage([300, 300]);
    const second = doc.addPage([300, 300]);
    const added = addPageAnnotations(
      doc,
      first,
      [
        { kind: "note", rect: [20, 200, 120, 260], text: "Revisar esta cifra", color: [1, 0.95, 0.6] },
        { kind: "link", rect: [20, 20, 120, 40], url: "https://example.org/año" },
        { kind: "link", rect: [150, 20, 250, 40], pageIndex: 1 },
        { kind: "note", rect: [0, 0, 10, 10], text: "  ", color: [1, 1, 0] },
      ],
      [first, second],
    );
    expect(added).toBe(3);

    const pdf = await getDocument({ data: (await doc.save()).slice(), verbosity: 0 }).promise;
    const annotations = await (await pdf.getPage(1)).getAnnotations();
    const note = annotations.find((a) => a.subtype === "Text");
    expect(note?.contentsObj?.str).toBe("Revisar esta cifra");
    // The icon sits at the note's top-left corner.
    expect([note?.rect[0], note?.rect[3]]).toEqual([20, 260]);
    const links = annotations.filter((a) => a.subtype === "Link");
    expect(links.map((a) => a.url).filter(Boolean)).toEqual(["https://example.org/a%C3%B1o"]);
    const internal = links.find((a) => a.dest);
    expect(await pdf.getPageIndex(internal!.dest[0])).toBe(1);
  });
});

describe("parseLinkInput", () => {
  it("tells page numbers, addresses and e-mails apart", () => {
    expect(parseLinkInput("12")).toEqual({ kind: "page", number: 12 });
    expect(parseLinkInput("pág. 3")).toEqual({ kind: "page", number: 3 });
    expect(parseLinkInput("example.org/x")).toEqual({ kind: "url", url: "https://example.org/x" });
    expect(parseLinkInput("ana@example.org")).toEqual({ kind: "url", url: "mailto:ana@example.org" });
    expect(parseLinkInput("tel:+34600000000")).toEqual({ kind: "url", url: "tel:+34600000000" });
    expect(parseLinkInput("javascript:alert(1)")).toEqual({ kind: "invalid" });
    expect(parseLinkInput("file:///etc/passwd")).toEqual({ kind: "invalid" });
    expect(parseLinkInput("hola mundo")).toEqual({ kind: "invalid" });
  });
});
