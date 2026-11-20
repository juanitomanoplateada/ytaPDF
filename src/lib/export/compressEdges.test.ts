import { PDFContentStream, PDFDocument, PDFName, PDFRawStream, type PDFDict, type PDFPage, type PDFRef } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontCache } from "../pdfText/fonts";
import { browserRecoder, compressImages, isRecodableJpeg, type RecodeRequest } from "./compress";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function withImages(images: Record<string, Record<string, unknown>>, content: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const { context } = doc;
  const refs: Record<string, PDFRef> = {};
  for (const [name, dict] of Object.entries(images)) {
    refs[name] = context.register(PDFRawStream.of(context.obj({ Type: "XObject", Subtype: "Image", ...dict } as never) as unknown as PDFDict, new Uint8Array(1000)));
  }
  page.node.set(PDFName.of("Resources"), context.obj({ XObject: refs } as never));
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(new TextEncoder().encode(content))));
  return { doc, page, refs };
}

describe("recodable JPEG images", () => {
  it("accepts plain DCT images in RGB, grey or ICC spaces", async () => {
    const { context } = await PDFDocument.create();
    const icc = (n: number) => context.register(context.stream(new Uint8Array(), { N: n }));
    const raw = (dict: Record<string, unknown>) => PDFRawStream.of(context.obj({ Filter: "DCTDecode", ...dict } as never) as unknown as PDFDict, new Uint8Array());
    expect(isRecodableJpeg(raw({ ColorSpace: "DeviceRGB" }))).toBe(true);
    expect(isRecodableJpeg(raw({ ColorSpace: "DeviceGray", BitsPerComponent: 8 }))).toBe(true);
    expect(isRecodableJpeg(raw({ ColorSpace: ["ICCBased", icc(3)] }))).toBe(true);
    expect(isRecodableJpeg(raw({ ColorSpace: ["ICCBased", icc(1)] }))).toBe(true);
    expect(isRecodableJpeg(raw({ ColorSpace: ["ICCBased", icc(4)] }))).toBe(false);
    expect(isRecodableJpeg(raw({ ColorSpace: ["ICCBased", 5] }))).toBe(false);
    expect(isRecodableJpeg(raw({ ColorSpace: ["Indexed", "DeviceRGB"] }))).toBe(false);
    expect(isRecodableJpeg(raw({ ColorSpace: "DeviceCMYK" }))).toBe(false);
    expect(isRecodableJpeg(raw({}))).toBe(false);
  });

  it("refuses masks, decode arrays, other depths and other filters", async () => {
    const { context } = await PDFDocument.create();
    const raw = (dict: Record<string, unknown>) => PDFRawStream.of(context.obj({ ColorSpace: "DeviceRGB", ...dict } as never) as unknown as PDFDict, new Uint8Array());
    expect(isRecodableJpeg(raw({ Filter: ["DCTDecode"] }))).toBe(true);
    expect(isRecodableJpeg(raw({ Filter: ["FlateDecode", "DCTDecode"] }))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: [5, "DCTDecode"] }))).toBe(true);
    expect(isRecodableJpeg(raw({ Filter: "FlateDecode" }))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: "DCTDecode", ImageMask: true }))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: "DCTDecode", Decode: [1, 0] }))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: "DCTDecode", SMaskInData: 1 }))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: "DCTDecode", BitsPerComponent: 16 }))).toBe(false);
    expect(isRecodableJpeg(raw({}))).toBe(false);
    expect(isRecodableJpeg(raw({ Filter: 5 }))).toBe(false);
    // Only raw (still encoded) streams can be copied as JPEG data.
    expect(isRecodableJpeg(PDFContentStream.of(context.obj({ Filter: "DCTDecode", ColorSpace: "DeviceRGB" }) as PDFDict, []))).toBe(false);
  });
});

describe("recompressing", () => {
  const options = { quality: 0.6, maxDpi: 72 };
  const shrink = (factor: number) => vi.fn(async (request: RecodeRequest) => new Uint8Array(Math.round(request.bytes.length * factor)));

  it("measures each image by its largest use and turns grey images into RGB", async () => {
    const { doc, page, refs } = await withImages(
      { Im: { Filter: "DCTDecode", ColorSpace: "DeviceGray", Width: 1000, Height: 1000 } },
      "q 100 0 0 100 0 0 cm /Im Do Q q 200 0 0 200 0 0 cm /Im Do Q /Im Do 0 0 m 1 1 l S BI /W 1 /H 1 /CS /G /BPC 8 ID x EI",
    );
    const recode = shrink(0.5);
    const report = await compressImages(doc, [page], new FontCache(doc.context), options, recode);
    expect(report).toEqual({ images: 1, before: 1000, after: 500 });
    expect(recode.mock.calls[0][0]).toMatchObject({ targetWidth: 200, targetHeight: 200 });
    const replaced = doc.context.lookup(refs.Im) as PDFRawStream;
    expect(replaced.dict.get(PDFName.of("ColorSpace"))).toEqual(PDFName.of("DeviceRGB"));
  });

  it("skips images it cannot or need not recode", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { doc, page } = await withImages(
      {
        Png: { Filter: "FlateDecode", ColorSpace: "DeviceRGB", Width: 10, Height: 10 },
        Flat: { Filter: "DCTDecode", ColorSpace: "DeviceRGB", Width: 0, Height: 10 },
        NoSize: { Filter: "DCTDecode", ColorSpace: "DeviceRGB" },
        Big: { Filter: "DCTDecode", ColorSpace: "DeviceRGB", Width: 100, Height: 100 },
      },
      "/Png Do /Flat Do /NoSize Do /Big Do",
    );
    const fonts = new FontCache(doc.context);
    expect(await compressImages(doc, [page], fonts, options, shrink(0.95))).toEqual({ images: 0, before: 0, after: 0 });
    expect(await compressImages(doc, [page], fonts, options, async () => null)).toMatchObject({ images: 0 });
    const failing = vi.fn(async () => {
      throw new Error("sin lienzo");
    });
    expect(await compressImages(doc, [page], fonts, options, failing)).toMatchObject({ images: 0 });
    expect(errors).toHaveBeenCalled();
  });

  it("skips images that are no longer raw streams", async () => {
    const { doc, page, refs } = await withImages({ Im: { Filter: "DCTDecode", ColorSpace: "DeviceRGB", Width: 10, Height: 10 } }, "/Im Do");
    doc.context.assign(refs.Im, doc.context.flateStream("x", { Type: "XObject", Subtype: "Image" }));
    expect(await compressImages(doc, [page as PDFPage], new FontCache(doc.context), options, shrink(0.1))).toMatchObject({ images: 0 });
  });
});

describe("browser recoder", () => {
  const request = { bytes: new Uint8Array(10), width: 4, height: 2, targetWidth: 2, targetHeight: 1, quality: 0.7 };

  function stubCanvas(bitmap: { width: number; height: number }, context: object | null) {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ ...bitmap, close })));
    const convertToBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])]));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext = () => context;
        convertToBlob = convertToBlob;
      },
    );
    return { close, convertToBlob };
  }

  it("scales the image down and encodes it as JPEG", async () => {
    const drawImage = vi.fn();
    const { close, convertToBlob } = stubCanvas({ width: 4, height: 2 }, { drawImage });
    expect(await browserRecoder(request)).toEqual(new Uint8Array([1, 2, 3]));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2, 1);
    expect(convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.7 });
    expect(close).toHaveBeenCalled();
  });

  it("gives up when the decoded size differs or there is no 2D context", async () => {
    expect(await (stubCanvas({ width: 2, height: 2 }, {}), browserRecoder(request))).toBeNull();
    const { close } = stubCanvas({ width: 4, height: 2 }, null);
    expect(await browserRecoder(request)).toBeNull();
    expect(close).toHaveBeenCalled();
  });
});
