// @vitest-environment jsdom
// @vitest-environment-options {"resources": "usable"}
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { createCanvas } from "canvas";
import { IText, Rect, type FabricObject } from "fabric";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageAnnotations, PageRef, SourceDocument } from "../editor.svelte";
import type { NativeText } from "../nativeText";

vi.mock("pdfjs-dist", async () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "pdfjs-dist/legacy/build/pdf.worker.mjs" }));

const require = createRequire(import.meta.url);
const fontFile = (path: string) => new Uint8Array(readFileSync(require.resolve(path)));
const NOTO = fontFile("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf");

const mocks = vi.hoisted(() => ({ rasterizePage: vi.fn(), assets: new Map<string, { bytes: Uint8Array; mime: string }>() }));
// Registered images are looked up by their URL; data URLs stand in for blob URLs, which jsdom cannot load.
vi.mock("../images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../images")>()),
  getImageAsset: (url: string) => mocks.assets.get(url),
}));
vi.mock("../embeddedFonts", () => ({
  embeddedFontBytes: async () => NOTO,
  scriptFontBytes: async () => NOTO,
  ensureFontsFor: async () => {},
}));
vi.mock("./raster", () => ({ rasterizePage: mocks.rasterizePage }));
vi.mock("../pdfText/apply", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pdfText/apply")>();
  return { ...original, applyNativeSpecs: vi.fn(original.applyNativeSpecs) };
});

const { exportDocument } = await import("./index");
const { i18n } = await import("../i18n.svelte");
const { applyNativeSpecs } = await import("../pdfText/apply");
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

const jpeg = () => new Uint8Array(createCanvas(10, 10).toBuffer("image/jpeg"));
const png = () => new Uint8Array(createCanvas(4, 4).toBuffer("image/png"));
const json = (object: FabricObject | NativeText) =>
  (object as FabricObject).toObject(["ytaKind", "ytaLink", "ytaNative"] as never) as Record<string, unknown>;

/** An image the editor registered: a data URL with its bytes. */
function registerImage(asset: { bytes: Uint8Array; mime: string }): string {
  const url = `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  mocks.assets.set(url, asset);
  return url;
}

beforeEach(() => {
  i18n.set("es");
  mocks.rasterizePage.mockReset();
  mocks.rasterizePage.mockImplementation(async () => jpeg());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A source of `count` pages with "Pagina n" on each, open in PDF.js. */
async function makeSource(id: string, count: number, build?: (doc: PDFDocument) => Promise<void> | void): Promise<SourceDocument> {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) doc.addPage([300, 200]).drawText(`Pagina ${i + 1}`, { x: 20, y: 100, size: 14, font: helvetica });
  await build?.(doc);
  const bytes = await doc.save();
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return { id, name: `${id}.pdf`, bytes, pdf: pdf as never, pageCount: count };
}

const pagesOf = (source: SourceDocument, order = [...Array(source.pageCount).keys()]): PageRef[] =>
  order.map((index, i) => ({ id: `p${i + 1}`, sourceId: source.id, sourceIndex: index, rotation: 0, width: 300, height: 200 }));

const input = (source: SourceDocument, changes: Record<string, unknown> = {}) => ({
  pages: pagesOf(source),
  annotations: {} as Record<string, PageAnnotations>,
  formValues: {},
  sources: new Map([[source.id, source]]),
  title: "Exportado",
  ...changes,
});

const load = (bytes: Uint8Array, password?: string) => PDFDocument.load(bytes, { password, updateMetadata: false });
const page = (objects: Record<string, unknown>[]): PageAnnotations => ({ version: "7", objects });

async function texts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const { items } = await (await pdf.getPage(i)).getTextContent();
    out.push(items.map((item) => ("str" in item ? item.str : "")).join(""));
  }
  return out;
}

describe("document properties", () => {
  it("edits documents in place, keeping their title, and writes new ones with the given one", async () => {
    const titled = await makeSource("a", 2, (doc) => doc.setTitle("Original"));
    const same = await load((await exportDocument(input(titled))).bytes);
    expect([same.getTitle(), same.getProducer()]).toEqual(["Original", "ytaPDF"]);

    const reordered = await load((await exportDocument(input(titled, { pages: pagesOf(titled, [1, 0]) }))).bytes);
    expect(reordered.getCreator()).toBe("ytaPDF");
    expect(reordered.getTitle()).toBe("Original");

    const untitled = await makeSource("b", 2);
    const named = await load(
      (await exportDocument(input(untitled, { pages: pagesOf(untitled, [1]), outline: [{ title: "Uno", pageIndex: 0, top: null, children: [] }] }))).bytes,
    );
    expect(named.getTitle()).toBe("Exportado");
    expect(named.catalog.has(PDFName.of("Outlines"))).toBe(true);
    const noOutline = await load((await exportDocument(input(untitled, { pages: pagesOf(untitled, [1]), outline: [] }))).bytes);
    expect(noOutline.catalog.has(PDFName.of("Outlines"))).toBe(false);
  });

  it("writes or strips metadata as asked", async () => {
    const source = await makeSource("a", 1, (doc) => doc.setAuthor("Alguien"));
    const written = await load((await exportDocument(input(source, { metadata: { title: "T", author: "", subject: "S", keywords: "" } }))).bytes);
    expect([written.getTitle(), written.getAuthor(), written.getSubject()]).toEqual(["T", undefined, "S"]);
    const stripped = await load((await exportDocument(input(source, { stripMetadata: true }))).bytes);
    expect(stripped.getAuthor()).toBeUndefined();
  });

  it("encrypts with a password, signs with a certificate, but not both", async () => {
    const source = await makeSource("a", 1);
    const encrypted = await exportDocument(input(source, { password: "clave" }));
    expect((await load(encrypted.bytes, "clave")).getPageCount()).toBe(1);

    const certificate = new Uint8Array(readFileSync("src/lib/export/fixtures/prueba-rsa.p12"));
    const signed = await exportDocument(input(source, { signature: { certificate, password: "secreto", reason: "  ", location: " Madrid " } }));
    const text = new TextDecoder("latin1").decode(signed.bytes);
    expect(text).toContain("/ByteRange");
    expect(text).not.toContain("/Reason");
    const withReason = await exportDocument(input(source, { signature: { certificate, password: "secreto", reason: "Conforme" } }));
    expect(new TextDecoder("latin1").decode(withReason.bytes)).toContain("/Reason");
    await expect(exportDocument(input(source, { password: "x", signature: { certificate, password: "secreto" } }))).rejects.toThrow(
      "Un documento firmado no se puede cifrar con contraseña.",
    );
  });

  it("flattens forms and reports fields it could not fill", async () => {
    const source = await makeSource("a", 1, (doc) => {
      const form = doc.getForm();
      const field = form.createTextField("corto");
      field.setMaxLength(2);
      field.addToPage(doc.getPage(0), { x: 10, y: 10 });
      form.createTextField("nombre").addToPage(doc.getPage(0), { x: 10, y: 60 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Cyrillic needs the embedded field font.
    const result = await exportDocument(input(source, { flattenForms: true, formValues: { a: { corto: "demasiado", nombre: "Анна" } } }));
    expect(result.warnings).toContain("No se pudieron rellenar algunos campos del formulario: corto.");
    expect((await load(result.bytes)).catalog.has(PDFName.of("AcroForm"))).toBe(false);
  });

  it("recompresses images when asked", async () => {
    const source = await makeSource("a", 1);
    const recodeImage = vi.fn(async () => null);
    const result = await exportDocument(input(source, { compression: { quality: 0.5, maxDpi: 72 }, recodeImage }));
    expect(result.compression).toEqual({ images: 0, before: 0, after: 0 });
    // Without a recoder of its own, the browser's is used (no images here to need it).
    const browser = await exportDocument(input(source, { compression: { quality: 0.5, maxDpi: 72 }, annotations: { p1: page([]) } }));
    expect(browser.compression?.images).toBe(0);
  });

  it("needs every page's source", async () => {
    const source = await makeSource("a", 1);
    const pages = [{ ...pagesOf(source)[0], sourceId: "falta" }];
    await expect(exportDocument(input(source, { pages, annotations: { p1: page([json(new Rect({ width: 5, height: 5, fill: "#f00" }))]) } }))).rejects.toThrow(
      "Falta el documento de origen.",
    );
    // A page made an image needs its source before anything else.
    const redact = new Rect({ left: 50, top: 50, width: 20, height: 20, fill: "#000" });
    redact.set({ ytaKind: "redact" } as never);
    const under = json(new Rect({ left: 50, top: 50, width: 30, height: 30, fill: "#f00" }));
    await expect(exportDocument(input(source, { pages, annotations: { p1: page([under, json(redact)]) } }))).rejects.toThrow(
      "Falta el documento de origen.",
    );
  });
});

describe("annotations", () => {
  it("draws shapes, text and images, warning about what could not be drawn", async () => {
    const source = await makeSource("a", 1);
    const asset = registerImage({ bytes: png(), mime: "image/png" });
    // Images not registered are fetched: one comes back as a JPEG, one as something else.
    const pngUrl = `data:image/png;base64,${Buffer.from(png()).toString("base64")}`;
    const fetched = `${pngUrl}#foto`;
    const broken = `${pngUrl}#rota`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        arrayBuffer: async () => (url === fetched ? jpeg() : url === broken ? new TextEncoder().encode("texto") : png()).buffer,
      })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const objects = [
      json(new Rect({ left: 50, top: 50, width: 20, height: 20, fill: "#00f" })),
      json(new IText("Привет", { left: 10, top: 10, fontFamily: "Helvetica" })),
      json(new IText("Hola 😀", { left: 10, top: 40, fontFamily: '"Noto Sans", sans-serif' })),
      { type: "Image", src: asset, width: 4, height: 4, left: 100, top: 100 },
      { type: "Image", src: fetched, width: 4, height: 4, left: 150, top: 100 },
      { type: "Image", src: broken, width: 4, height: 4, left: 200, top: 100 },
      { type: "Image", src: `${pngUrl}#otra`, width: 4, height: 4, left: 250, top: 100 },
    ];
    const result = await exportDocument(input(source, { annotations: { p1: page(objects) } }));
    expect(result.warnings.some((w) => w.includes("fuentes estándar"))).toBe(true);
    expect(result.warnings.some((w) => w.startsWith("La fuente elegida no tiene"))).toBe(true);
    expect(result.warnings).toContain("Una imagen no se pudo incluir en el PDF.");
    const twoBroken = [
      { type: "Image", src: broken, width: 4, height: 4 },
      { type: "Image", src: `${broken}2`, width: 4, height: 4 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new TextEncoder().encode("texto").buffer })));
    expect((await exportDocument(input(source, { annotations: { p1: page(twoBroken) } }))).warnings).toContain(
      "2 imágenes no se pudieron incluir en el PDF.",
    );
  });

  it("writes notes and links, dropping links that go nowhere", async () => {
    const source = await makeSource("a", 2);
    const note = new IText("Revisar", { left: 20, top: 20, backgroundColor: "#ffff00" });
    note.set({ ytaKind: "note" } as never);
    const link = (target: Record<string, string> | null) => {
      const rect = new Rect({ left: 60, top: 60, width: 20, height: 10 });
      rect.set({ ytaKind: "link", ...(target ? { ytaLink: target } : {}) } as never);
      return json(rect);
    };
    const result = await exportDocument(
      input(source, {
        annotations: {
          p1: page([json(note), link({ pageId: "p2" }), link({ url: "https://ejemplo.es" }), link({ pageId: "borrada" }), link(null)]),
          p2: page([link(null)]),
        },
      }),
    );
    expect(result.warnings).toContain("3 enlaces no tenían destino (o su página ya no está) y no se incluyeron.");
    const doc = await load(result.bytes);
    expect(doc.getPage(0).node.Annots()?.size()).toBe(3);
    const single = await exportDocument(input(source, { annotations: { p1: page([link(null)]) } }));
    expect(single.warnings).toContain("Un enlace no tenía destino (o su página ya no está) y no se incluyó.");
  });
});

describe("redaction", () => {
  const redactBox = (left: number, top: number, width = 120, height = 30) => {
    const box = new Rect({ left, top, width, height, fill: "#000" });
    box.set({ ytaKind: "redact" } as never);
    return json(box);
  };

  it("cuts the text under redaction boxes, with notes and recognised words under them", async () => {
    const source = await makeSource("a", 1);
    const note = new IText("oculta", { left: 75, top: 95 });
    note.set({ ytaKind: "note" } as never);
    const quad = (x: number, y: number): [number, number][] => [[x, y], [x + 40, y], [x + 40, y + 10], [x, y + 10]];
    const result = await exportDocument(
      input(source, {
        annotations: { p1: page([redactBox(75, 95), json(note)]) },
        ocr: {
          "a:0": {
            languages: "spa",
            lines: [{ quad: quad(20, 95), words: [{ text: "Pagina", quad: quad(20, 95) }, { text: "visible", quad: quad(200, 20) }] }],
          },
        },
      }),
    );
    expect((await texts(result.bytes))[0]).not.toContain("Pagina 1");
    expect((await texts(result.bytes))[0]).toContain("visible");
    expect((await load(result.bytes)).getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("exports pages as images when a box covers an image, or when the content cannot be cut", async () => {
    const source = await makeSource("a", 2, (doc) => {
      doc.getForm().createTextField("campo").addToPage(doc.getPage(1), { x: 10, y: 80, width: 200, height: 40 });
    });
    const asset = registerImage({ bytes: png(), mime: "image/png" });
    const covered = { type: "Image", src: asset, width: 40, height: 40, left: 75, top: 95 };
    const quad: [number, number][] = [[10, 10], [50, 10], [50, 20], [10, 20]];
    const result = await exportDocument(
      input(source, {
        annotations: { p1: page([covered, redactBox(75, 95)]), p2: page([redactBox(100, 100)]) },
        ocr: { "a:0": { languages: "spa", lines: [{ quad, words: [{ text: "palabra", quad }] }] }, "a:1": { languages: "spa", lines: [] } },
      }),
    );
    expect(mocks.rasterizePage).toHaveBeenCalledTimes(2 + 1);
    expect(result.warnings).toContain(
      "Las 2 páginas con zonas censuradas se exportaron como imagen porque había imágenes o campos de formulario bajo la censura.",
    );
    const one = await exportDocument(input(source, { pages: pagesOf(source, [0]), annotations: { p1: page([covered, redactBox(75, 95)]) } }));
    expect(one.warnings).toContain(
      "La página con zonas censuradas se exportó como imagen porque había una imagen o un campo de formulario bajo la censura.",
    );
  });

  it("writes recognised text of pages without boxes and notes of pages made images", async () => {
    const source = await makeSource("a", 2);
    const quad: [number, number][] = [[20, 20], [80, 20], [80, 30], [20, 30]];
    const asset = registerImage({ bytes: png(), mime: "image/png" });
    const note = new IText("nota", { left: 200, top: 30 });
    note.set({ ytaKind: "note" } as never);
    const result = await exportDocument(
      input(source, {
        annotations: { p2: page([{ type: "Image", src: asset, width: 40, height: 40, left: 75, top: 95 }, redactBox(75, 95), json(note)]) },
        ocr: { "a:0": { languages: "spa", lines: [{ quad, words: [{ text: "escaneado", quad }] }] } },
      }),
    );
    expect((await texts(result.bytes))[0]).toContain("escaneado");
    expect((await load(result.bytes)).getPage(1).node.Annots()?.size()).toBe(1);
  });

  it("leaves recognised text out when every word is under a box", async () => {
    const source = await makeSource("a", 1);
    const quad: [number, number][] = [[80, 105], [120, 105], [120, 115], [80, 115]];
    const result = await exportDocument(
      input(source, { annotations: { p1: page([redactBox(75, 95)]) }, ocr: { "a:0": { languages: "spa", lines: [{ quad, words: [{ text: "oculta", quad }] }] } } }),
    );
    expect((await texts(result.bytes))[0]).not.toContain("oculta");
  });
});

describe("edited document text", () => {
  it("applies native text, warning about substituted characters and texts that failed", async () => {
    const { analyzePage } = await import("../pdfText/analyze");
    const { FontCache } = await import("../pdfText/fonts");
    const { createNativeText } = await import("../nativeText");
    const source = await makeSource("a", 1);
    const doc = await PDFDocument.load(source.bytes);
    const analysis = analyzePage(doc.getPage(0), new FontCache(doc.context));
    const pdfPage = await source.pdf.getPage(1);
    const viewport = pdfPage.getViewport({ scale: 1 }).transform as [number, number, number, number, number, number];
    const object = createNativeText(analysis.lines[0], analysis, viewport);
    object.set("text", "Página Ж");
    object.initDimensions();
    const result = await exportDocument(input(source, { annotations: { p1: page([json(object)]) } }));
    expect(result.warnings[0]).toMatch(/^Algunos caracteres no existen en la fuente original del documento/);
    expect((await texts(result.bytes))[0]).toContain("Página");

    vi.mocked(applyNativeSpecs).mockResolvedValueOnce({ failed: ["a"] });
    const one = await exportDocument(input(source, { annotations: { p1: page([json(object)]) } }));
    expect(one.warnings).toContain("Un texto editado del documento no se pudo aplicar y se dejó como estaba.");
    vi.mocked(applyNativeSpecs).mockResolvedValueOnce({ failed: ["a", "b"] });
    const two = await exportDocument(input(source, { annotations: { p1: page([json(object)]) } }));
    expect(two.warnings).toContain("2 textos editados del documento no se pudieron aplicar y se dejaron como estaban.");
  });
});
