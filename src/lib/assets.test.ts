import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Fonts ────────────────────────────────────────────────────────────────

describe("embedded fonts", () => {
  let faces: { family: string; source: string; descriptors: FontFaceDescriptors }[];
  let failing: Set<string>;

  beforeEach(() => {
    vi.resetModules();
    faces = [];
    failing = new Set();
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(
          readonly family: string,
          readonly source: string,
          readonly descriptors: FontFaceDescriptors,
        ) {
          faces.push(this);
        }
        load = async () => {
          if (failing.has(this.family)) throw new Error("sin red");
          return this;
        };
      },
    );
    vi.stubGlobal("document", { fonts: { add: vi.fn() } });
  });

  async function load() {
    const fonts = await import("./embeddedFonts");
    const { cache } = await import("fabric");
    const clear = vi.spyOn(cache, "clearFontCache");
    return { ...fonts, clear };
  }

  it("loads the four variants of a family once and refreshes measurements", async () => {
    const { ensureFamilyLoaded, clear } = await load();
    await ensureFamilyLoaded("noto-serif");
    await ensureFamilyLoaded("noto-serif");
    expect(faces.map((f) => f.descriptors)).toEqual([
      { weight: "400", style: "normal" },
      { weight: "700", style: "normal" },
      { weight: "400", style: "italic" },
      { weight: "700", style: "italic" },
    ]);
    expect(clear).toHaveBeenCalledWith("Noto Serif");
  });

  it("tries again after a family fails to load", async () => {
    const { ensureFamilyLoaded } = await load();
    failing.add("Noto Sans");
    await expect(ensureFamilyLoaded("noto-sans")).rejects.toThrow("sin red");
    failing.clear();
    await ensureFamilyLoaded("noto-sans");
    expect(faces).toHaveLength(8);
  });

  it("loads script fonts with their bold files, and says when any had to be loaded", async () => {
    const { ensureScriptFontsFor, ensureScriptFontLoaded, clear } = await load();
    expect(await ensureScriptFontsFor("hola")).toBe(false);
    expect(await ensureScriptFontsFor("مرحبا")).toBe(true);
    expect(await ensureScriptFontsFor("مرحبا")).toBe(false);
    expect(new Set(faces.map((f) => f.source)).size).toBe(2);
    expect(clear).toHaveBeenCalledWith();
    const family = faces[0].family;
    failing.add(family);
    await ensureScriptFontLoaded("noto-sans-kr");
    failing.clear();
    const kr = faces.at(-1)!.family;
    failing.add(kr);
    await expect(ensureScriptFontLoaded("noto-sans-sc")).resolves.toBeUndefined();
  });

  it("retries script fonts that failed", async () => {
    const { ensureScriptFontLoaded } = await load();
    const { SCRIPT_FONT_NAMES } = await import("./fonts");
    failing.add(SCRIPT_FONT_NAMES["noto-sans-kr"]);
    await expect(ensureScriptFontLoaded("noto-sans-kr")).rejects.toThrow("sin red");
    failing.clear();
    await ensureScriptFontLoaded("noto-sans-kr");
    expect(faces).toHaveLength(8);
  });

  it("finds the families and scripts serialised objects need, in groups too", async () => {
    const { ensureFontsFor } = await load();
    await ensureFontsFor([
      { type: "IText", text: "hola", fontFamily: '"Noto Sans", sans-serif' },
      { type: "Group", objects: [{ type: "IText", text: "中文", fontFamily: "Helvetica" }] },
      { type: "Rect", fontFamily: 5 },
    ]);
    const families = new Set(faces.map((f) => f.family));
    expect(families.has("Noto Sans")).toBe(true);
    expect(families.size).toBe(2);
  });

  it("downloads font files once, retrying after a failure", async () => {
    const { scriptFontBytes, embeddedFontBytes } = await load();
    const fetch = vi.fn(async () => ({ ok: false }) as Response);
    vi.stubGlobal("fetch", fetch);
    await expect(embeddedFontBytes("noto-sans", "bold")).rejects.toThrow("No se pudo cargar la fuente");
    fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer } as Response);
    expect(await embeddedFontBytes("noto-sans", "bold")).toEqual(new Uint8Array([1, 2]));
    expect(await embeddedFontBytes("noto-sans", "bold")).toEqual(new Uint8Array([1, 2]));
    await scriptFontBytes("noto-sans-arabic", true);
    await scriptFontBytes("noto-sans-arabic", false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

// ── Images ───────────────────────────────────────────────────────────────

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);

/** A JPEG with an APP1 Exif segment holding `orientation` (or other bytes). */
function jpeg(orientation: number | null, little = false): Uint8Array {
  const tiff: number[] = little ? [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0] : [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8];
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const entries = orientation === null ? [...u16(1), ...u16(0x0100), 0, 3, 0, 0, 0, 1, 0, 0, 0, 0] : [...u16(1), ...u16(0x0112), 0, 3, 0, 0, 0, 1, ...u16(orientation), 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, ...entries];
  const length = exif.length + 2;
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xe1, length >> 8, length & 0xff, ...exif, 0xff, 0xda, 0, 2);
}

describe("image types", () => {
  it("recognises PNG, JPEG and SVG by their first bytes", async () => {
    const { sniffImageType } = await import("./images");
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe("other");
    expect(sniffImageType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(sniffImageType(Uint8Array.of(0xff, 0xd8, 0xff))).toBe("other");
    const text = (s: string) => new TextEncoder().encode(s);
    expect(sniffImageType(text("  <svg xmlns='x'/>"))).toBe("svg");
    expect(sniffImageType(text('<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(sniffImageType(text('<?xml version="1.0"?><html/>'))).toBe("other");
  });

  it("reads the EXIF orientation of JPEG photos", async () => {
    const { readJpegOrientation } = await import("./images");
    expect(readJpegOrientation(jpeg(6))).toBe(6);
    expect(readJpegOrientation(jpeg(3, true))).toBe(3);
    expect(readJpegOrientation(jpeg(9))).toBe(1);
    expect(readJpegOrientation(jpeg(null))).toBe(1);
    expect(readJpegOrientation(Uint8Array.of(0xff, 0xd8, 0x00, 0x00, 0, 0))).toBe(1);
    expect(readJpegOrientation(Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 2))).toBe(1);
    expect(readJpegOrientation(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 2))).toBe(1);
    // Exif segments cut short at each step.
    const full = jpeg(6);
    const app1 = 8;
    expect(readJpegOrientation(full.slice(0, app1 + 12))).toBe(1);
    expect(readJpegOrientation(full.slice(0, app1 + 10 + 9))).toBe(1);
    expect(readJpegOrientation(full.slice(0, app1 + 10 + 8 + 4))).toBe(1);
    const noEntries = full.slice(0, app1 + 10 + 8 + 2);
    expect(readJpegOrientation(noEntries)).toBe(1);
    // An APP1 segment that is not Exif is skipped.
    const xmp = Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x68, 0x74, 0x74, 0x70, 0, 0, 0xff, 0xda, 0, 2);
    expect(readJpegOrientation(xmp)).toBe(1);
  });
});

describe("importing images", () => {
  function stubCanvas(options: { context?: boolean; blob?: boolean } = {}) {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (options.context === false ? null : { drawImage }),
      toBlob: (resolve: (blob: Blob | null) => void, type: string) => resolve(options.blob === false ? null : new Blob([type])),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    return { canvas, drawImage };
  }

  function stubUrls() {
    let n = 0;
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => `blob:${++n}`, revokeObjectURL: revoke }));
    return revoke;
  }

  beforeEach(() => vi.resetModules());

  it("keeps PNG and upright JPEG files as they are, and forgets them on release", async () => {
    const revoke = stubUrls();
    const images = await import("./images");
    const png = await images.importImage(new Blob([PNG]));
    expect(images.getImageAsset(png)?.mime).toBe("image/png");
    const photo = await images.importImage(new Blob([jpeg(1) as BlobPart]));
    expect(images.getImageAsset(photo)?.mime).toBe("image/jpeg");
    images.releaseImageAssets();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(images.getImageAsset(png)).toBeUndefined();
  });

  it("re-encodes rotated photos as JPEG and other images as PNG, at a sensible size", async () => {
    stubUrls();
    const { canvas } = stubCanvas();
    const close = vi.fn();
    const bitmap = vi.fn(async () => ({ width: 8000, height: 2000, close }));
    vi.stubGlobal("createImageBitmap", bitmap);
    const { readImageAsset } = await import("./images");
    const rotated = await readImageAsset(new Blob([jpeg(6) as BlobPart]));
    expect(rotated.mime).toBe("image/jpeg");
    expect([canvas.width, canvas.height]).toEqual([4096, 1024]);
    expect(close).toHaveBeenCalled();

    bitmap.mockResolvedValueOnce({ width: 100, height: 0, close });
    const svg = await readImageAsset(new Blob(["<svg/>"]));
    expect(svg.mime).toBe("image/png");
    // Vectors are drawn large enough to stay sharp.
    // An unknown height counts as 1024, the longest side, which becomes 2048.
    expect([canvas.width, canvas.height]).toEqual([200, 2048]);
  });

  it("falls back to an image element when bitmaps cannot be made", async () => {
    const revoke = stubUrls();
    stubCanvas();
    vi.stubGlobal("createImageBitmap", async () => Promise.reject(new Error("no")));
    const decode = vi.fn(async () => {});
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 0;
        naturalHeight = 30;
        decoding = "";
        src = "";
        decode = decode;
      },
    );
    const { readImageAsset } = await import("./images");
    expect((await readImageAsset(new Blob(["GIF89a"]))).mime).toBe("image/png");
    expect(revoke).toHaveBeenCalled();
    decode.mockRejectedValueOnce(new Error("no"));
    await expect(readImageAsset(new Blob(["GIF89a"]))).rejects.toThrow("El formato de la imagen no es compatible.");
  });

  it("fails when the canvas cannot draw or encode", async () => {
    stubUrls();
    vi.stubGlobal("createImageBitmap", async () => ({ width: 10, height: 10, close: () => {} }));
    stubCanvas({ context: false });
    const images = await import("./images");
    await expect(images.readImageAsset(new Blob(["x"]))).rejects.toThrow("No se pudo preparar la imagen.");
    stubCanvas({ blob: false });
    await expect(images.readImageAsset(new Blob(["x"]))).rejects.toThrow("No se pudo convertir la imagen.");
  });
});
