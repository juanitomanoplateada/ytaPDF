import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Boundaries of the store: PDF.js, files, storage, export, OCR and the text worker ──

const state = vi.hoisted(() => ({
  canPick: true,
  recovery: false,
}));

const mocks = vi.hoisted(() => ({
  openPdf: vi.fn(),
  pageTextContent: vi.fn(),
  syncFormStorage: vi.fn(async () => {}),
  downloadBytes: vi.fn((..._args: unknown[]) => {}),
  ensureWritable: vi.fn(async () => true),
  pickSaveLocation: vi.fn(),
  printPdf: vi.fn(async () => {}),
  releasePrintFrame: vi.fn(),
  shareFile: vi.fn(async () => true),
  writeToHandle: vi.fn(async () => {}),
  clearRecoveryCopies: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => [] as unknown[]),
  loadSession: vi.fn(),
  saveSession: vi.fn(async (_session: unknown) => {}),
  setRecoveryEnabled: vi.fn(),
  clearThumbnailCache: vi.fn(),
  textReset: vi.fn(),
  analyze: vi.fn(async () => ({ fonts: [], lines: [], paragraphs: [], paragraphOf: [] })),
  getImageAsset: vi.fn(),
  importImage: vi.fn(async () => "blob:imagen"),
  readImageAsset: vi.fn(),
  registerImage: vi.fn(() => "blob:nueva"),
  releaseImageAssets: vi.fn(),
  exportDocument: vi.fn(async (_input: unknown) => ({ bytes: new Uint8Array([1]), warnings: [] as string[] })),
  rasterizePage: vi.fn(async () => new Uint8Array([2])),
  replaceOnPage: vi.fn(),
  redactionBoxesFor: vi.fn(() => [] as unknown[]),
  ocrRedactionBoxes: vi.fn(() => [] as unknown[]),
  recognizePage: vi.fn(),
  stopOcr: vi.fn(async () => {}),
  readPkcs12: vi.fn(),
  describeCertificate: vi.fn(),
}));

class PasswordCancelledError extends Error {}

vi.mock("./pdfjs", () => ({
  openPdf: mocks.openPdf,
  pageTextContent: mocks.pageTextContent,
  PasswordCancelledError,
  syncFormStorage: mocks.syncFormStorage,
  viewportOf: (proxy: { view: number[] }, scale: number, geometry: { rotation?: number; crop?: number[] } | number = 0) => {
    const { rotation = 0, crop } = typeof geometry === "number" ? { rotation: geometry } : geometry;
    const [x0, y0, x1, y1] = crop ?? proxy.view;
    const [w, h] = [(x1 - x0) * scale, (y1 - y0) * scale];
    const swap = rotation % 180 !== 0;
    return { width: swap ? h : w, height: swap ? w : h, transform: [scale, 0, 0, -scale, -x0 * scale, y1 * scale] };
  },
}));
vi.mock("./deliver", () => ({
  get canPickSaveLocation() {
    return state.canPick;
  },
  downloadBytes: mocks.downloadBytes,
  ensureWritable: mocks.ensureWritable,
  MIME: { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", zip: "application/zip" },
  pickSaveLocation: mocks.pickSaveLocation,
  printPdf: mocks.printPdf,
  releasePrintFrame: mocks.releasePrintFrame,
  shareFile: mocks.shareFile,
  writeToHandle: mocks.writeToHandle,
}));
vi.mock("./session", () => ({
  clearRecoveryCopies: mocks.clearRecoveryCopies,
  deleteSession: mocks.deleteSession,
  listSessions: mocks.listSessions,
  loadSession: mocks.loadSession,
  recoveryEnabled: () => state.recovery,
  saveSession: mocks.saveSession,
  setRecoveryEnabled: mocks.setRecoveryEnabled,
}));
vi.mock("./thumbnails", () => ({ clearThumbnailCache: mocks.clearThumbnailCache }));
vi.mock("./pdfText/service", () => ({ textEditing: { reset: mocks.textReset, analyze: mocks.analyze } }));
vi.mock("./images", () => ({
  getImageAsset: mocks.getImageAsset,
  importImage: mocks.importImage,
  readImageAsset: mocks.readImageAsset,
  registerImage: mocks.registerImage,
  releaseImageAssets: mocks.releaseImageAssets,
}));
vi.mock("./export", async () => {
  const { CertificateError } = await import("./export/sign");
  return { exportDocument: mocks.exportDocument, CertificateError };
});
vi.mock("./export/raster", () => ({ rasterizePage: mocks.rasterizePage }));
vi.mock("./textReplace", () => ({
  replaceOnPage: mocks.replaceOnPage,
  redactionBoxesFor: mocks.redactionBoxesFor,
  ocrRedactionBoxes: mocks.ocrRedactionBoxes,
}));
vi.mock("./ocr", () => ({ recognizePage: mocks.recognizePage, stopOcr: mocks.stopOcr }));
vi.mock("./export/sign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./export/sign")>()),
  readPkcs12: mocks.readPkcs12,
  describeCertificate: mocks.describeCertificate,
}));

// ── Fake documents ──────────────────────────────────────────────────────

interface Spec {
  pages?: [number, number][];
  outline?: unknown;
  metadata?: unknown;
  fields?: unknown;
  text?: string[];
}

function fakePdf(spec: Spec = {}) {
  const sizes = spec.pages ?? [[600, 800]];
  const proxies = sizes.map(([w, h], i) => ({
    view: [0, 0, w, h],
    rotate: 0,
    text: spec.text?.[i] ?? "",
    getViewport: ({ scale }: { scale: number }) => ({ width: w * scale, height: h * scale }),
  }));
  return {
    numPages: sizes.length,
    getPage: vi.fn(async (n: number) => proxies[n - 1]),
    loadingTask: { destroy: vi.fn(async () => {}) },
    getMetadata: vi.fn(async () => {
      if (spec.metadata instanceof Error) throw spec.metadata;
      return spec.metadata ?? { info: {} };
    }),
    getFieldObjects: vi.fn(async () => {
      if (spec.fields instanceof Error) throw spec.fields;
      return spec.fields ?? null;
    }),
    getOutline: vi.fn(async () => spec.outline ?? null),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
  };
}

type FullSpec = Spec & { password?: string; broken?: boolean };
/** Specs by the token their "PDF" carries, so maps and errors survive. */
const specs = new Map<string, FullSpec>();

/** A "PDF" whose bytes name the spec the fake PDF.js opens. */
const pdfBytes = (spec: FullSpec = {}) => {
  const token = `spec-${specs.size}`;
  specs.set(token, spec);
  return new TextEncoder().encode(`%PDF-${token}`);
};
const pdfFile = (name: string, spec: FullSpec = {}) => new File([pdfBytes(spec) as BlobPart], name);

/** The spec of fake bytes, or the page size of a real PDF (blank pages). */
function specOf(bytes: Uint8Array): FullSpec {
  const text = new TextDecoder("latin1").decode(bytes);
  const token = /%PDF-(spec-\d+)/.exec(text)?.[1];
  if (token) return specs.get(token)!;
  const box = /MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(text);
  return box ? { pages: [[Number(box[1]), Number(box[2])]] } : {};
}

type Editor = typeof import("./editor.svelte").editor;
let editor: Editor;
let notifications: typeof import("./notifications.svelte").notifications;

const messages = () => notifications.items.map((n) => n.message);
const lastMessage = () => notifications.items.at(-1)?.message;

beforeEach(async () => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockClear();
  state.canPick = true;
  state.recovery = false;
  mocks.openPdf.mockImplementation(async (bytes: Uint8Array, ask: (incorrect: boolean) => Promise<string | null>) => {
    const spec = specOf(bytes);
    if (spec.broken) throw new Error("dañado");
    let password: string | undefined;
    if (spec.password) {
      let typed = await ask(false);
      if (typed !== spec.password && typed !== null) typed = await ask(true);
      if (typed === null) throw new PasswordCancelledError();
      password = typed;
    }
    return { pdf: fakePdf(spec), password };
  });
  mocks.pageTextContent.mockImplementation(async (page: { text: string }) => {
    if (page.text === "ERROR") throw new Error("ilegible");
    const parts = page.text.split("|");
    const items = parts.map((str, i) => ({ str, hasEOL: i === parts.length - 1 }));
    return { items: [...items, { type: "beginMarkedContent" }], styles: {} };
  });
  ({ editor } = await import("./editor.svelte"));
  ({ notifications } = await import("./notifications.svelte"));
  (await import("./i18n.svelte")).i18n.set("es");
  notifications.items = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(spec: Spec = { pages: [[600, 800], [600, 800], [600, 800]] }, name = "informe.pdf") {
  await editor.openFiles([pdfFile(name, spec)]);
  return editor.pages;
}

/** A page controller whose every method is a spy. */
function controller(overrides: Record<string, unknown> = {}) {
  const names = [
    "addImage",
    "addSignature",
    "addMark",
    "addText",
    "markText",
    "applyTextStyle",
    "applyShapeStyle",
    "rotateSelection",
    "flipSelection",
    "setSelectionOpacity",
    "arrangeSelection",
    "alignSelection",
    "distributeSelection",
    "groupSelection",
    "ungroupSelection",
    "setSelectionBounds",
    "toggleLockSelection",
    "deleteSelection",
    "duplicateSelection",
    "copySelection",
    "pasteObjects",
    "nudgeSelection",
    "clearSelection",
    "isEditingText",
    "restoreOriginalText",
    "setLinkTarget",
  ];
  return { ...Object.fromEntries(names.map((name) => [name, vi.fn()])), ...overrides } as never as Record<string, ReturnType<typeof vi.fn>>;
}

const selectionInfo = (changes: Record<string, unknown> = {}) => ({ count: 1, kind: "rect", text: null, shape: null, highlight: null, ...changes }) as never;

// ── Opening documents ───────────────────────────────────────────────────

describe("opening documents", () => {
  it("opens a PDF as a new document, remembering the file Save may overwrite", async () => {
    const handle = { name: "informe.pdf" };
    await editor.openFiles([pdfFile("Informe Final.pdf", { pages: [[600, 800], [400, 300]] })], { handles: [handle as never] });
    expect(editor.documentName).toBe("Informe Final");
    expect(editor.pages.map((p) => [p.width, p.height])).toEqual([
      [600, 800],
      [400, 300],
    ]);
    expect(editor.currentPageId).toBe(editor.pages[0].id);
    expect(editor.saveTargetName).toBe("informe.pdf");
    expect(editor.hasDocument).toBe(true);
    expect(editor.fileName).toBe("Informe Final_ytaPDF");
  });

  it("does nothing without files or while busy", async () => {
    await editor.openFiles([]);
    editor.busy = "ocupado";
    await editor.openFiles([pdfFile("a.pdf")]);
    expect(mocks.openPdf).not.toHaveBeenCalled();
  });

  it("explains files that are not PDFs, are damaged or need a password nobody gave", async () => {
    await editor.openFiles([new File(["hola"], "nota.txt"), pdfFile("roto.pdf", { broken: true })]);
    expect(messages()).toEqual(["«nota.txt» no es un archivo PDF.", "No se pudo abrir «roto.pdf». El archivo puede estar dañado."]);
    const opening = editor.openFiles([pdfFile("secreto.pdf", { password: "clave" })]);
    await vi.waitFor(() => expect(editor.passwordRequest).not.toBeNull());
    expect(editor.passwordRequest).toMatchObject({ fileName: "secreto.pdf", incorrect: false });
    editor.passwordRequest!.resolve("otra");
    await vi.waitFor(() => expect(editor.passwordRequest?.incorrect).toBe(true));
    editor.passwordRequest!.resolve(null);
    await opening;
    expect(lastMessage()).toBe("No se abrió «secreto.pdf» porque requiere contraseña.");
    expect(editor.hasDocument).toBe(false);
  });

  it("opens several files at once, and adds files to the open document", async () => {
    const busy: (string | null)[] = [];
    mocks.openPdf.mockImplementationOnce(async (bytes: Uint8Array) => (busy.push(editor.busy), { pdf: fakePdf(specOf(bytes)) }));
    await editor.openFiles([pdfFile("a.pdf"), pdfFile("b.pdf")], { handles: [{ name: "a.pdf" } as never] });
    expect(busy).toEqual(["Abriendo documentos…"]);
    expect(editor.pages).toHaveLength(2);
    expect(editor.saveTargetName).toBeNull();
    await editor.openFiles([pdfFile("c.pdf")]);
    expect(lastMessage()).toBe("Se añadieron 1 página al final.");
    await editor.openFiles([pdfFile("d.pdf", { pages: [[1, 1], [1, 1]] })], { insertAt: 1 });
    expect(lastMessage()).toBe("Se insertaron 2 páginas a partir de la posición 2.");
    expect(editor.pages).toHaveLength(5);
    notifications.items.at(-1)!.action!.run();
    expect(editor.pages).toHaveLength(3);
    await editor.openFiles([pdfFile("e.pdf")], { insertAt: -5 });
    expect(editor.pages[0].sourceId).not.toBe(editor.pages[1].sourceId);
  });

  it("names documents without a usable name generically", async () => {
    await editor.openFiles([pdfFile(".pdf")]);
    expect(editor.documentName).toBe("documento");
  });

  it("creates a blank document, but not over an open one", async () => {
    await editor.createBlankDocument(300, 400);
    expect(editor.pages[0]).toMatchObject({ width: 300, height: 400 });
    expect(editor.sources.values().next().value!.generated).toBe(true);
    await editor.createBlankDocument();
    expect(editor.pages).toHaveLength(1);
  });

  it("turns images into pages, reporting those it cannot use", async () => {
    await editor.addImagePages([]);
    mocks.readImageAsset.mockImplementation(async (file: File) => {
      if (file.name === "mal.png") throw new Error("no");
      return { bytes: new Uint8Array(), mime: "image/png" };
    });
    vi.doMock("./imagePdf", async () => {
      const { makeBlankPdf } = await import("./blankPdf");
      return { imagesToPdf: vi.fn(async (assets: unknown[]) => makeBlankPdf(100, 100 * assets.length)) };
    });
    await editor.addImagePages([new File([], "foto.jpg"), new File([], "mal.png")]);
    expect(editor.documentName).toBe("imagenes");
    expect(lastMessage()).toBe("No se pudo usar «mal.png» como imagen.");
    await editor.addImagePages([new File([], "otra.png")], 0);
    expect(editor.pages).toHaveLength(2);
    await editor.addImagePages([new File([], "mal.png")]);
    expect(editor.pages).toHaveLength(2);

    vi.doMock("./imagePdf", () => ({ imagesToPdf: vi.fn(async () => Promise.reject(new Error("sin memoria"))) }));
    vi.resetModules();
    ({ editor } = await import("./editor.svelte"));
    ({ notifications } = await import("./notifications.svelte"));
    await editor.addImagePages([new File([], "foto.jpg")]);
    expect(notifications.items.at(-1)?.message).toBe("No se pudieron convertir las imágenes en páginas.");
    vi.doUnmock("./imagePdf");
  });

  it("closes the document, forgetting everything but kept works", async () => {
    await open();
    editor.closeDocument();
    expect(editor.hasDocument).toBe(false);
    expect(mocks.deleteSession).toHaveBeenCalled();
    expect(mocks.releaseImageAssets).toHaveBeenCalled();
    await open();
    editor.keptWork = true;
    mocks.deleteSession.mockClear();
    editor.closeDocument();
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});

// ── Names and properties ────────────────────────────────────────────────

describe("names and properties", () => {
  it("renames the document and chooses the name of exported files", async () => {
    await open();
    editor.renameDocument("  ...  ");
    expect(editor.documentName).toBe("informe");
    editor.renameDocument("Nuevo");
    editor.setFileName("Nuevo_ytaPDF");
    expect(editor.customFileName).toBeNull();
    editor.setFileName("copia");
    expect(editor.fileName).toBe("copia");
    editor.setFileName("");
    expect(editor.customFileName).toBeNull();
  });

  it("reads the document's properties unless the user set their own", async () => {
    expect(await editor.documentMetadata()).toEqual({ title: "", author: "", subject: "", keywords: "" });
    await open({ metadata: { info: { Title: "Título", Author: 5 } } });
    expect(await editor.documentMetadata()).toEqual({ title: "Título", author: "", subject: "", keywords: "" });
    editor.setMetadata({ title: "Mío", author: "", subject: "", keywords: "" }, true);
    expect((await editor.documentMetadata()).title).toBe("Mío");
    expect((await editor.documentMetadata(true)).title).toBe("Título");
    expect(editor.stripMetadata).toBe(true);
    editor.closeDocument();
    await open({ metadata: { info: null } });
    expect((await editor.documentMetadata()).title).toBe("");
    editor.closeDocument();
    await open({ metadata: new Error("no") });
    expect((await editor.documentMetadata()).title).toBe("");
  });

  it("tells whether any page has form fields", async () => {
    expect(await editor.hasFormFields()).toBe(false);
    await open({ fields: new Map([["campo", []]]) });
    expect(await editor.hasFormFields()).toBe(true);
    editor.closeDocument();
    await open({ fields: { campo: [] } });
    expect(await editor.hasFormFields()).toBe(true);
    editor.closeDocument();
    await open({ fields: new Map() });
    expect(await editor.hasFormFields()).toBe(false);
    await editor.openFiles([pdfFile("b.pdf", { fields: {} }), pdfFile("c.pdf", { fields: new Error("no") })]);
    expect(await editor.hasFormFields()).toBe(false);
  });

  it("decorates pages and shows the decorations under the annotations", async () => {
    const { DEFAULT_DECORATIONS } = await import("./decorations");
    const pages = await open();
    editor.setPageAnnotations(pages[0].id, { version: "7", objects: [{ type: "Rect" }] });
    expect(editor.renderedAnnotations).toBe(editor.annotations);
    editor.setDecorations({ ...DEFAULT_DECORATIONS, fromPage: 2 });
    expect(editor.renderedAnnotations[pages[0].id].objects).toEqual([{ type: "Rect" }]);
    expect(editor.renderedAnnotations[pages[1].id].objects[0]).toMatchObject({ text: "1 / 2" });
    editor.setDecorations({ ...DEFAULT_DECORATIONS, numbers: { ...DEFAULT_DECORATIONS.numbers, enabled: false } });
    expect(editor.decorations).toBeNull();
  });
});

// ── Saving and exporting ────────────────────────────────────────────────

describe("saving", () => {
  it("downloads the PDF, or overwrites the file it came from once the user agrees", async () => {
    await editor.exportPdf();
    await open();
    await editor.exportPdf();
    expect(mocks.downloadBytes).toHaveBeenCalledWith(new Uint8Array([1]), "informe_ytaPDF.pdf", "application/pdf");
    expect(lastMessage()).toBe("PDF exportado correctamente.");
    expect(editor.isDirty).toBe(false);

    editor.closeDocument();
    const handle = { name: "informe.pdf" };
    await editor.openFiles([pdfFile("informe.pdf")], { handles: [handle as never] });
    const declined = editor.exportPdf();
    await vi.waitFor(() => expect(editor.overwriteRequest).not.toBeNull());
    editor.overwriteRequest!.resolve(false);
    await declined;
    expect(mocks.writeToHandle).not.toHaveBeenCalled();

    const accepted = editor.exportPdf();
    await vi.waitFor(() => expect(editor.overwriteRequest).not.toBeNull());
    editor.overwriteRequest!.resolve(true);
    await accepted;
    expect(mocks.writeToHandle).toHaveBeenCalledWith(handle, new Uint8Array([1]));
    expect(lastMessage()).toBe("Se guardó «informe.pdf».");

    // Confirmed once, it is not asked again; failures are reported.
    mocks.ensureWritable.mockResolvedValueOnce(false);
    await editor.exportPdf();
    expect(lastMessage()).toBe("El navegador no dio permiso para guardar en «informe.pdf». Usa «Guardar como» para elegir otro archivo.");
    mocks.writeToHandle.mockRejectedValueOnce(new Error("disco"));
    await editor.exportPdf();
    expect(lastMessage()).toBe("No se pudo guardar en «informe.pdf». Usa «Guardar como» para elegir otro archivo.");
    mocks.exportDocument.mockResolvedValueOnce({ bytes: new Uint8Array([1]), warnings: ["aviso"] });
    await editor.exportPdf();
    expect(lastMessage()).toBe("aviso");
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    await editor.exportPdf();
    expect(lastMessage()).toBe("No se pudo generar el PDF. Si el problema continúa, prueba a quitar la última anotación añadida.");
  });

  it("saves as a chosen file, which Save then keeps writing to", async () => {
    const pages = await open();
    expect(await editor.saveAs({ fileName: "x", pageIds: [] })).toBe(false);
    mocks.pickSaveLocation.mockResolvedValueOnce(null);
    expect(await editor.saveAs({ fileName: "x" })).toBe(false);
    const handle = { name: "elegido.pdf" };
    mocks.pickSaveLocation.mockResolvedValueOnce(handle);
    expect(await editor.saveAs({ fileName: "elegido", password: "clave" })).toBe(true);
    expect(lastMessage()).toBe("Se guardó «elegido.pdf» con contraseña.");
    expect(editor.saveTargetName).toBe("elegido.pdf");
    await editor.exportPdf();
    expect(mocks.exportDocument.mock.calls.at(-1)![0]).toMatchObject({ password: "clave" });

    mocks.pickSaveLocation.mockRejectedValueOnce(new Error("política"));
    expect(await editor.saveAs({ fileName: "partes", pageIds: [pages[0].id] })).toBe(true);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(new Uint8Array([1]), "partes.pdf", "application/pdf");
    expect(lastMessage()).toBe("Se exportaron 1 página.");

    mocks.pickSaveLocation.mockResolvedValueOnce(handle);
    mocks.writeToHandle.mockRejectedValueOnce(new Error("disco"));
    expect(await editor.saveAs({ fileName: "" })).toBe(false);
    expect(lastMessage()).toBe("No se pudo guardar «elegido.pdf».");

    mocks.pickSaveLocation.mockResolvedValueOnce(handle);
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    expect(await editor.saveAs({ fileName: "x" })).toBe(false);
  });

  it("downloads with the chosen name where files cannot be picked, and mentions signatures", async () => {
    state.canPick = false;
    const pages = await open();
    expect(await editor.saveAs({ fileName: "firmado", signature: { certificate: new Uint8Array(), password: "x" } })).toBe(true);
    expect(lastMessage()).toBe("PDF exportado correctamente. Lleva tu firma digital: cualquier cambio posterior la invalidará.");
    expect(await editor.saveAs({ fileName: "dos", pageIds: [pages[0].id, pages[1].id], password: "x" })).toBe(true);
    expect(lastMessage()).toBe("Se exportaron 2 páginas con contraseña.");
    expect(await editor.saveAs({ fileName: "todo", password: "x" })).toBe(true);
    expect(lastMessage()).toBe("PDF exportado con contraseña.");
  });

  it("reports certificate problems in words", async () => {
    const { CertificateError } = await import("./export/sign");
    await open();
    const problems = ["password", "no-key", "unsupported-key", "format"] as const;
    for (const problem of problems) {
      mocks.exportDocument.mockRejectedValueOnce(new CertificateError(problem));
      await editor.exportPdf();
    }
    expect(messages().slice(-4)).toEqual([
      "La contraseña del certificado no es correcta.",
      "El archivo no incluye la clave privada del certificado: expórtalo de nuevo con ella.",
      "Este certificado usa claves de curva elíptica, que todavía no se admiten. Usa un certificado con clave RSA.",
      "El archivo no es un certificado PKCS#12 (.p12 o .pfx) válido.",
    ]);
  });

  it("tells what image recompression achieved", async () => {
    await open();
    mocks.exportDocument.mockResolvedValueOnce({ bytes: new Uint8Array(), warnings: [], compression: { images: 2, before: 2048, after: 1024 } } as never);
    await editor.exportPdf();
    expect(messages()).toContain("Se recomprimieron 2 imágenes: de 2 KB a 1 KB.");
    mocks.exportDocument.mockResolvedValueOnce({ bytes: new Uint8Array(), warnings: [], compression: { images: 0, before: 0, after: 0 } } as never);
    await editor.exportPdf();
    expect(messages()).toContain("Las imágenes del documento ya estaban bien comprimidas: no se cambiaron.");
  });

  it("exports some pages, prints and shares", async () => {
    const pages = await open();
    await editor.exportPages([]);
    await editor.exportPages([pages[0].id]);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(expect.anything(), "informe_ytaPDF_pagina.pdf", "application/pdf");
    await editor.exportPages([pages[0].id, pages[2].id]);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(expect.anything(), "informe_ytaPDF_paginas.pdf", "application/pdf");
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    await editor.exportPages([pages[0].id]);

    await editor.printDocument([]);
    await editor.printDocument();
    expect(mocks.printPdf).toHaveBeenCalled();
    mocks.printPdf.mockRejectedValueOnce(new Error("bloqueado"));
    await editor.printDocument();
    expect(lastMessage()).toBe("No se pudo abrir la impresión. Exporta el PDF e imprímelo desde tu visor.");
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    await editor.printDocument();

    await editor.shareDocument({ pageIds: [] });
    await editor.shareDocument({ fileName: "compartido" });
    expect(mocks.shareFile).toHaveBeenLastCalledWith(expect.anything(), "compartido.pdf", "application/pdf");
    mocks.shareFile.mockRejectedValueOnce(new DOMException("tarde", "NotAllowedError"));
    await editor.shareDocument();
    expect(lastMessage()).toBe("El PDF está listo para compartir.");
    notifications.items.at(-1)!.action!.run();
    await vi.waitFor(() => expect(mocks.shareFile).toHaveBeenCalledTimes(3));
    mocks.shareFile.mockRejectedValueOnce(new Error("roto"));
    await editor.shareDocument();
    expect(lastMessage()).toBe("No se pudo compartir el archivo.");
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    await editor.shareDocument();
  });

  it("does not build two PDFs at once", async () => {
    await open();
    editor.busy = "ocupado";
    await editor.exportPdf();
    expect(mocks.exportDocument).not.toHaveBeenCalled();
  });

  it("exports pages as images, one file or a ZIP", async () => {
    const pages = await open();
    expect(await editor.exportImages({ pageIds: [], format: "image/png", dpi: 72, fileName: "x" })).toBe(false);
    expect(await editor.exportImages({ pageIds: [pages[1].id], format: "image/png", dpi: 72, fileName: "foto.png" })).toBe(true);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(new Uint8Array([2]), "foto_pagina-2.png", "image/png");
    expect(lastMessage()).toBe("Imagen exportada.");
    expect(await editor.exportImages({ pageIds: pages.map((p) => p.id), format: "image/jpeg", dpi: 72, fileName: "" })).toBe(true);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(expect.any(Uint8Array), "informe_ytaPDF_imagenes.zip", "application/zip");
    expect(lastMessage()).toBe("Se exportaron 3 imágenes en un archivo ZIP.");
    mocks.rasterizePage.mockRejectedValueOnce(new Error("roto"));
    expect(await editor.exportImages({ pageIds: [pages[0].id], format: "image/png", dpi: 72, fileName: "x" })).toBe(false);
    expect(lastMessage()).toBe("No se pudieron generar las imágenes.");
    editor.sources.clear();
    expect(await editor.exportImages({ pageIds: [pages[0].id], format: "image/png", dpi: 72, fileName: "x" })).toBe(false);
    editor.busy = "ocupado";
    expect(await editor.exportImages({ pageIds: [pages[0].id], format: "image/png", dpi: 72, fileName: "x" })).toBe(false);
  });

  it("splits the document into one or several files", async () => {
    await open();
    expect(await editor.splitDocument([[9]], "x")).toBe(false);
    expect(await editor.splitDocument([[0, 1, 2]], "")).toBe(true);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(expect.anything(), "informe_ytaPDF_paginas_1-3.pdf", "application/pdf");
    expect(lastMessage()).toBe("PDF exportado correctamente.");
    mocks.exportDocument.mockResolvedValueOnce({ bytes: new Uint8Array([1]), warnings: ["aviso"] });
    expect(await editor.splitDocument([[0], [1, 2]], "partes")).toBe(true);
    expect(mocks.downloadBytes).toHaveBeenLastCalledWith(expect.anything(), "partes_dividido.zip", "application/zip");
    expect(lastMessage()).toBe("aviso");
    expect(await editor.splitDocument([[0], [2]], "partes")).toBe(true);
    expect(lastMessage()).toBe("Se crearon 2 archivos PDF en un ZIP.");
    mocks.exportDocument.mockRejectedValueOnce(new Error("roto"));
    expect(await editor.splitDocument([[0]], "x")).toBe(false);
    editor.busy = "ocupado";
    expect(await editor.splitDocument([[0]], "x")).toBe(false);
  });
});

// ── Pages ───────────────────────────────────────────────────────────────

describe("pages", () => {
  it("deletes pages, keeping at least one, and moves to a page that remains", async () => {
    const pages = await open();
    editor.goToPage(pages[2].id);
    editor.setPageAnnotations(pages[2].id, { objects: [{ type: "Rect" }] });
    editor.deletePages(["nada"]);
    editor.deletePage(pages[2].id);
    expect(lastMessage()).toBe("Página 3 eliminada.");
    expect(editor.currentPageId).toBe(pages[1].id);
    expect(editor.annotations[pages[2].id]).toBeUndefined();
    editor.deletePages([pages[0].id, pages[1].id]);
    expect(lastMessage()).toBe("Un documento necesita al menos una página. Para empezar de nuevo, cierra el documento.");
    editor.undo();
    editor.goToPage(pages[2].id);
    editor.deletePages([pages[0].id, pages[1].id]);
    expect(lastMessage()).toBe("Se eliminaron 2 páginas.");
    expect(editor.currentPageId).toBe(pages[2].id);
    notifications.items.at(-1)!.action!.run();
    expect(editor.pages).toHaveLength(3);
  });

  it("moves, duplicates, reverses and rotates pages", async () => {
    const pages = await open();
    editor.movePage("nada", 0);
    editor.movePage(pages[0].id, 0);
    editor.movePage(pages[0].id, 9);
    expect(editor.pages.at(-1)).toBe(pages[0]);
    editor.movePages([], 0);
    editor.movePages([pages[0].id], 3);
    editor.movePages([pages[0].id], 0);
    expect(editor.pages[0]).toBe(pages[0]);
    editor.movePages([pages[1].id, pages[2].id], -1);

    editor.duplicatePages(["nada"]);
    editor.setPageAnnotations(pages[0].id, { objects: [{ type: "Rect" }] });
    editor.duplicatePages([pages[0].id]);
    expect(lastMessage()).toBe("Página duplicada.");
    expect(Object.keys(editor.annotations)).toHaveLength(2);
    editor.duplicatePages([pages[1].id, pages[2].id]);
    expect(lastMessage()).toBe("Se duplicaron 2 páginas.");
    notifications.items.at(-1)!.action!.run();

    editor.reversePages([pages[0].id]);
    editor.reversePages();
    expect(lastMessage()).toBe("Se invirtió el orden de las páginas.");
    editor.reversePages([pages[1].id, pages[2].id]);
    expect(lastMessage()).toBe("Se invirtió el orden de las páginas seleccionadas.");
    notifications.items.at(-1)!.action!.run();

    editor.rotatePages([], 90);
    editor.rotatePages([pages[1].id], 90);
    const turned = editor.pages.find((p) => p.id === pages[1].id)!;
    expect([turned.rotation, turned.width, turned.height]).toEqual([90, 800, 600]);
    editor.rotatePages([pages[0].id], 180);
    expect(editor.pages.find((p) => p.id === pages[0].id)).toMatchObject({ rotation: 180, width: 600 });
  });

  it("inserts blank pages sized like their neighbour", async () => {
    const pages = await open({ pages: [[300, 200], [400, 500]] });
    await editor.insertBlankPage(pages[0].id);
    expect(editor.pages[1]).toMatchObject({ width: 300, height: 200 });
    expect(lastMessage()).toBe("Página en blanco insertada en la posición 2.");
    await editor.insertBlankPage(null);
    expect(editor.pages.at(-1)).toMatchObject({ width: 400, height: 500 });
    await editor.insertBlankPage("nada");
    expect(editor.pages[0]).toMatchObject({ width: 400 });
    notifications.items.at(-1)!.action!.run();
    editor.closeDocument();
    await editor.insertBlankPage(null);
    expect(editor.pages[0]).toMatchObject({ width: 595.28, height: 841.89 });
    mocks.openPdf.mockRejectedValueOnce(new PasswordCancelledError());
    await editor.insertBlankPage(null);
    expect(editor.pages).toHaveLength(1);
  });

  it("goes to pages by id and by number", async () => {
    const pages = await open();
    const scrollToPage = vi.fn();
    const unregister = editor.registerViewport({ scrollToPage, fitWidth: () => null, fitPage: () => null });
    editor.goToPageNumber(Number.NaN);
    editor.goToPageNumber(9);
    expect(editor.currentPageId).toBe(pages[2].id);
    expect(scrollToPage).toHaveBeenLastCalledWith(pages[2].id, false);
    editor.goToPageNumber(-3);
    expect(editor.currentPageIndex).toBe(0);
    unregister();
    unregister();
    editor.goToPage(pages[1].id);
    expect(scrollToPage).toHaveBeenCalledTimes(2);
    editor.closeDocument();
    editor.goToPageNumber(1);
  });
});

describe("cropping", () => {
  it("crops one page or all with the same margins, moving annotations along", async () => {
    const pages = await open({ pages: [[600, 800], [600, 800], [300, 400]] });
    await editor.applyCrop("page");
    editor.setPageAnnotations(pages[0].id, { objects: [{ type: "Rect", left: 100, top: 100 }, { type: "Rect" }] });
    editor.pendingCrop = { pageId: pages[0].id, rect: { x: 50, y: 50, width: 400, height: 600 } };
    await editor.applyCrop("page");
    expect(lastMessage()).toBe("Página recortada.");
    expect(editor.pages[0]).toMatchObject({ crop: [50, 150, 450, 750], width: 400, height: 600 });
    expect(editor.annotations[pages[0].id].objects).toEqual([
      { type: "Rect", left: 50, top: 50 },
      { type: "Rect", left: -50, top: -50 },
    ]);
    expect(editor.tool).toBe("select");

    editor.pendingCrop = { pageId: pages[1].id, rect: { x: 10, y: 10, width: 500, height: 700 } };
    await editor.applyCrop("all");
    expect(lastMessage()).toBe("Se recortaron 3 páginas.");
    notifications.items.at(-1)!.action!.run();

    editor.pendingCrop = { pageId: pages[1].id, rect: { x: 10, y: 10, width: 5, height: 700 } };
    await editor.applyCrop("page");
    editor.pendingCrop = { pageId: "nada", rect: { x: 0, y: 0, width: 1, height: 1 } };
    await editor.applyCrop("page");
    // Without its source nothing is cropped.
    editor.pendingCrop = { pageId: pages[1].id, rect: { x: 10, y: 10, width: 500, height: 700 } };
    const source = editor.sources.get(pages[1].sourceId)!;
    editor.sources.delete(pages[1].sourceId);
    await editor.applyCrop("page");
    editor.sources.set(source.id, source);
  });

  it("removes crops", async () => {
    const pages = await open();
    await editor.removeCrop([pages[0].id]);
    editor.pendingCrop = { pageId: pages[0].id, rect: { x: 50, y: 50, width: 400, height: 600 } };
    await editor.applyCrop("page");
    await editor.removeCrop([pages[0].id]);
    expect(lastMessage()).toBe("Se quitó el recorte.");
    expect(editor.pages[0].crop).toBeUndefined();
    notifications.items.at(-1)!.action!.run();
    editor.sources.clear();
    await editor.removeCrop([pages[0].id]);
  });
});

// ── Annotations and history ─────────────────────────────────────────────

describe("annotations and history", () => {
  it("stores annotations of existing pages and removes empty ones", async () => {
    const pages = await open();
    expect(editor.setPageAnnotations("nada", { objects: [{}] })).toBeUndefined();
    expect(editor.setPageAnnotations(pages[0].id, null)).toBeUndefined();
    expect(editor.setPageAnnotations(pages[0].id, { objects: [{ type: "Rect" }] })).toEqual({ objects: [{ type: "Rect" }] });
    expect(editor.setPageAnnotations(pages[0].id, { objects: [] })).toBeUndefined();
    expect(editor.annotations[pages[0].id]).toBeUndefined();
  });

  it("joins quick edits with the same key into one undo step, but not across a save", async () => {
    const pages = await open();
    expect([editor.canUndo, editor.canRedo]).toEqual([false, false]);
    const data = (n: number) => ({ objects: [{ type: "Rect", n }] });
    editor.setPageAnnotations(pages[0].id, data(1), "k");
    editor.setPageAnnotations(pages[0].id, data(2), "k");
    // One step: undoing it goes back to before the first edit.
    editor.undo();
    expect(editor.annotations[pages[0].id]).toBeUndefined();
    editor.redo();
    expect(editor.annotations[pages[0].id]).toEqual(data(2));
    editor.redo();
    // Undo and redo end the step; a save keeps the next edit apart too.
    editor.setPageAnnotations(pages[0].id, data(3), "k");
    editor.setPageAnnotations(pages[0].id, data(4), "k");
    await editor.exportPdf();
    editor.setPageAnnotations(pages[0].id, data(5), "k");
    expect(editor.isDirty).toBe(true);
    editor.undo();
    expect(editor.annotations[pages[0].id]).toEqual(data(4));
    expect(editor.isDirty).toBe(false);
    editor.undo();
    editor.undo();
    editor.undo();
    expect(editor.canUndo).toBe(false);
    // Editing after undoing past the save loses it.
    editor.setPageAnnotations(pages[0].id, data(5));
    editor.redo();
    expect(editor.isDirty).toBe(true);
  });

  it("keeps a hundred steps, forgetting the oldest (and the save if it was among them)", async () => {
    const pages = await open();
    await editor.exportPdf();
    for (let i = 0; i < 101; i++) editor.setPageAnnotations(pages[0].id, { objects: [{ i }] });
    let steps = 0;
    while (editor.canUndo) {
      editor.undo();
      steps++;
    }
    expect(steps).toBe(99);
    expect(editor.isDirty).toBe(true);
    editor.closeDocument();
    await open();
    for (let i = 0; i < 50; i++) editor.setPageAnnotations(editor.pages[0].id, { objects: [{ i }] });
    await editor.exportPdf();
    for (let i = 0; i < 60; i++) editor.setPageAnnotations(editor.pages[0].id, { objects: [{ i }] });
    for (let i = 0; i < 60; i++) editor.undo();
    expect(editor.isDirty).toBe(false);
  });

  it("moves to a page that exists after undoing its insertion", async () => {
    await open();
    await editor.openFiles([pdfFile("b.pdf")]);
    editor.goToPage(editor.pages[3].id);
    editor.undo();
    expect(editor.currentPageId).toBe(editor.pages[2].id);
  });

  it("writes form values into the pages, once per change", async () => {
    const pages = await open();
    const sourceId = pages[0].sourceId;
    editor.setFormValue(sourceId, "nombre", "Ana");
    editor.setFormValue(sourceId, "nombre", "Ana");
    await vi.waitFor(() => expect(editor.formRevision[sourceId]).toBe(1));
    editor.setFormValue("otra", "campo", "x");
    editor.undo();
    await vi.waitFor(() => expect(editor.formRevision[sourceId]).toBe(1));
    editor.undo();
    await vi.waitFor(() => expect(editor.formRevision[sourceId]).toBe(2));
    expect(mocks.syncFormStorage).toHaveBeenCalledTimes(2);
  });

  it("flushes pending edits before history changes", async () => {
    await open();
    const flush = vi.fn();
    const unregister = editor.registerFlusher(flush);
    editor.undo();
    unregister();
    editor.redo();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

// ── Bookmarks ───────────────────────────────────────────────────────────

describe("bookmarks", () => {
  const outline = [{ title: "Capítulo", dest: [{ num: 1 }, { name: "Fit" }], items: [] }];

  it("shows a single file's bookmarks, and one per file for several", async () => {
    await open({ pages: [[600, 800], [600, 800]], outline });
    await vi.waitFor(() => expect(editor.bookmarks.map((b) => b.title)).toEqual(["Capítulo"]));
    expect(editor.bookmarks[0].pageId).toBe(editor.pages[1].id);
    await editor.openFiles([pdfFile("anexo.pdf")]);
    await editor.insertBlankPage(null);
    await vi.waitFor(() => expect(editor.bookmarks.map((b) => b.title)).toEqual(["informe", "anexo"]));
    editor.duplicatePages([editor.pages[0].id]);
    await vi.waitFor(() => expect(editor.bookmarks).toHaveLength(2));
  });

  it("drops the result of a refresh overtaken by another, and survives outlines it cannot read", async () => {
    await open({ outline });
    editor.movePage(editor.pages[0].id, 0);
    await editor.openFiles([pdfFile("b.pdf")]);
    editor.rotatePages([editor.pages[0].id], 90);
    await vi.waitFor(() => expect(editor.bookmarks).toHaveLength(2));
    const source = editor.sources.values().next().value!;
    (source.pdf as unknown as { getOutline: () => Promise<never> }).getOutline = () => Promise.reject(new Error("no"));
    await editor.openFiles([pdfFile("c.pdf")]);
    await vi.waitFor(() => expect(editor.bookmarks).toHaveLength(3));
  });
});

// ── Content from the toolbar ────────────────────────────────────────────

describe("adding content", () => {
  it("adds images, signatures, marks, dates and pasted text to the page in view", async () => {
    await editor.addImage(new File([], "foto.png"));
    expect(lastMessage()).toBe("Abre la vista de edición para añadir imágenes.");
    await editor.insertSignature({ path: "M 0 0", width: 1, height: 1, color: "#000", strokeWidth: 1 });
    expect(lastMessage()).toBe("Abre la vista de edición para añadir la firma.");
    editor.addMark("check");
    editor.addTodayDate();

    const pages = await open();
    const page = controller();
    const other = controller();
    editor.registerPage(pages[0].id, page as never);
    editor.registerPage(pages[1].id, other as never);
    await editor.addImage(new File([], "foto.png"));
    expect(page.addImage).toHaveBeenCalledWith("blob:imagen");
    await editor.addImage(new File([], "foto.png"), pages[1].id);
    expect(other.addImage).toHaveBeenCalled();
    mocks.importImage.mockRejectedValueOnce(new Error("no"));
    await editor.addImage(new File([], "rota.png"));
    expect(lastMessage()).toBe("No se pudo usar «rota.png» como imagen.");

    editor.openSignature(true);
    expect([editor.signatureOpen, editor.signatureInitials]).toEqual([true, true]);
    await editor.insertSignature({ path: "M 0 0", width: 1, height: 1, color: "#000", strokeWidth: 1 });
    expect(page.addSignature).toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["x"]) })));
    await editor.insertSignature({ image: "data:image/png;base64,", width: 1, height: 1, initials: true });
    expect(page.addImage).toHaveBeenLastCalledWith("blob:imagen", { width: 90 });
    editor.currentPageId = "nada";
    await editor.insertSignature({ image: "data:image/png;base64,", width: 1, height: 1 });
    expect(page.addImage).toHaveBeenLastCalledWith("blob:imagen", { width: 220 });
    editor.currentPageId = pages[0].id;
    mocks.importImage.mockRejectedValueOnce(new Error("no"));
    await editor.insertSignature({ image: "data:", width: 1, height: 1 });
    expect(lastMessage()).toBe("No se pudo insertar la firma.");

    editor.addMark("cross");
    expect(page.addMark).toHaveBeenCalledWith("cross");
    editor.addTodayDate();
    expect(page.addText).toHaveBeenCalledWith(expect.stringMatching(/\d{2}\/\d{2}\/\d{4}/), { fontSize: 14 });
    editor.addTextFromClipboard(" \r\n ");
    editor.addTextFromClipboard("uno\r\ndos");
    expect(page.addText).toHaveBeenLastCalledWith("uno\ndos");
  });

  it("marks the text selected in the document", async () => {
    await open();
    editor.markSelectedText("highlight");
    const removeAllRanges = vi.fn();
    const selection = (collapsed: boolean, ranges = 1) => ({ isCollapsed: collapsed, rangeCount: ranges, getRangeAt: () => ({}), removeAllRanges });
    vi.stubGlobal("getSelection", () => selection(true));
    editor.markSelectedText("highlight");
    vi.stubGlobal("getSelection", () => selection(false, 0));
    editor.markSelectedText("highlight");
    vi.stubGlobal("getSelection", () => selection(false));
    const page = controller({ markText: vi.fn(() => 0) });
    editor.registerPage(editor.pages[0].id, page as never);
    editor.selectedText = "algo";
    editor.markSelectedText("underline");
    expect(lastMessage()).toBe("Selecciona texto del documento para marcarlo.");
    expect(editor.selectedText).toBe("");
    page.markText.mockReturnValue(2);
    notifications.items = [];
    editor.markSelectedText("strikeout");
    expect(notifications.items).toEqual([]);
    expect(removeAllRanges).toHaveBeenCalledTimes(2);
  });
});

// ── Text across pages ───────────────────────────────────────────────────

describe("text across pages", () => {
  it("replaces text everywhere as a single step", async () => {
    expect(await editor.replaceText("  ", "x")).toBe(0);
    const pages = await open();
    mocks.replaceOnPage.mockImplementation(async (_a: unknown, _v: unknown, _d: unknown, query: string) =>
      query === "nada" ? { data: null, replaced: 0, skipped: 0 } : { data: { objects: [{ type: "NativeLine" }] }, replaced: query === "uno" ? 1 : 2, skipped: query === "dos" ? 1 : 0 },
    );
    expect(await editor.replaceText("nada", "x")).toBe(0);
    expect(lastMessage()).toBe("No se encontró «nada» en el texto del documento.");
    expect(await editor.replaceText("uno", "x")).toBe(3);
    expect(messages()).toContain("Se reemplazaron 3 coincidencias.");
    notifications.items.find((n) => n.message === "Se reemplazaron 3 coincidencias.")!.action!.run();
    mocks.replaceOnPage.mockResolvedValueOnce({ data: null, replaced: 1, skipped: 0 });
    mocks.replaceOnPage.mockResolvedValue({ data: null, replaced: 0, skipped: 0 });
    expect(await editor.replaceText("x", "y")).toBe(1);
    expect(lastMessage()).toBe("Se reemplazó 1 coincidencia.");
    mocks.replaceOnPage.mockResolvedValue({ data: null, replaced: 0, skipped: 2 });
    await editor.replaceText("dos", "y");
    expect(lastMessage()).toBe("6 coincidencias están en texto que no se puede editar (su fuente no indica qué caracteres dibuja).");
    mocks.replaceOnPage.mockRejectedValueOnce(new Error("roto"));
    expect(await editor.replaceText("x", "y")).toBe(0);
    expect(lastMessage()).toBe("No se pudo reemplazar el texto.");
    // Pages without their source are skipped; nothing happens while busy.
    editor.sources.delete(pages[0].sourceId);
    mocks.replaceOnPage.mockClear();
    await editor.replaceText("x", "y");
    expect(mocks.replaceOnPage).not.toHaveBeenCalled();
    editor.busy = "ocupado";
    await editor.replaceText("x", "y");
  });

  it("covers matches with redaction boxes, recognised text included", async () => {
    expect(await editor.redactText(" ")).toBe(0);
    const pages = await open();
    expect(await editor.redactText("nada")).toBe(0);
    expect(lastMessage()).toBe("No se encontró «nada» en el texto del documento.");
    mocks.redactionBoxesFor.mockReturnValueOnce([{ type: "Rect" }]);
    expect(await editor.redactText("uno")).toBe(1);
    expect(lastMessage()).toBe("Se cubrió 1 coincidencia con una zona censurada. Se eliminará del archivo al exportar.");
    editor.setPageAnnotations(pages[1].id, { objects: [{ type: "IText" }] });
    mocks.redactionBoxesFor.mockReturnValue([{ type: "Rect" }]);
    mocks.ocrRedactionBoxes.mockReturnValueOnce([{ type: "Rect", ocr: true }]);
    expect(await editor.redactText("dos")).toBe(4);
    expect(editor.annotations[pages[1].id].objects).toHaveLength(2);
    notifications.items.at(-1)!.action!.run();
    mocks.redactionBoxesFor.mockImplementationOnce(() => {
      throw new Error("roto");
    });
    expect(await editor.redactText("x")).toBe(0);
    expect(lastMessage()).toBe("No se pudo censurar el texto.");
  });

  it("reads the document's text, recognised text included", async () => {
    await open({ pages: [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]], text: ["Ho|la", "  ", "ERROR", "Adiós", " "] });
    await editor.openFiles([pdfFile("b.pdf")]);
    editor.sources.delete(editor.pages[5].sourceId);
    const page = editor.pages[1];
    editor.ocr = { [`${page.sourceId}:1`]: { languages: "spa", lines: [{ quad: [[0, 0], [1, 0], [1, 1], [0, 1]], words: [{ text: "escaneado", quad: [[0, 0], [1, 0], [1, 1], [0, 1]] }] }] } };
    expect(await editor.documentText()).toBe("Hola\n\nescaneado\n\nAdiós");
    expect(await editor.documentText([editor.pages[3].id])).toBe("Adiós");
  });
});

// ── OCR ─────────────────────────────────────────────────────────────────

describe("recognising text", () => {
  const ocrPage = (words: number) => ({
    languages: "spa",
    lines: [{ quad: [], words: Array.from({ length: words }, () => ({ text: "x", quad: [] })) }],
  });

  it("recognises each source page once, reporting progress", async () => {
    vi.useFakeTimers();
    state.recovery = true;
    vi.resetModules();
    ({ editor } = await import("./editor.svelte"));
    ({ notifications } = await import("./notifications.svelte"));
    const pages = await open({ pages: [[1, 1], [1, 1]] });
    editor.duplicatePages([pages[0].id]);
    mocks.recognizePage.mockImplementation(async (_proxy: unknown, _languages: unknown, onProgress: (p: { progress: number; status: string }) => void) => {
      onProgress({ progress: 0.5, status: "recognizing" });
      onProgress({ progress: 0.1, status: "loading" });
      return ocrPage(2);
    });
    const onProgress = vi.fn();
    expect(await editor.recognizeText(editor.pages.map((p) => p.id), ["spa"], { onProgress })).toBe(true);
    expect(mocks.recognizePage).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith({ page: 1, total: 2, fraction: 0.5, loading: false });
    expect(onProgress).toHaveBeenCalledWith({ page: 1, total: 2, fraction: 0, loading: true });
    expect(notifications.items.at(-1)?.message).toBe(
      "Se reconoció el texto de 2 páginas. Ya se puede buscar, seleccionar y copiar, y se guardará en el PDF.",
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.saveSession).toHaveBeenCalled();

    mocks.recognizePage.mockResolvedValue({ languages: "spa", lines: [] });
    await editor.recognizeText([pages[0].id], ["eng"]);
    expect(notifications.items.at(-1)?.message).toBe("No se encontró texto en 1 página.");
  });

  it("skips pages with their own text when asked", async () => {
    await open({ pages: [[1, 1], [1, 1], [1, 1]], text: ["x".repeat(30), "ERROR", "poco"] });
    mocks.recognizePage.mockResolvedValue(ocrPage(1));
    await editor.recognizeText([editor.pages[0].id], ["spa"], { onlyWithoutText: true });
    expect(lastMessage()).toBe("Todas las páginas elegidas ya tienen texto. Elige «Todas» para reconocerlas igualmente.");
    await editor.recognizeText(editor.pages.map((p) => p.id), ["spa"], { onlyWithoutText: true });
    expect(mocks.recognizePage).toHaveBeenCalledTimes(2);
  });

  it("stops when asked, keeping what was recognised", async () => {
    await open({ pages: [[1, 1], [1, 1]] });
    const aborted = new AbortController();
    aborted.abort();
    expect(await editor.recognizeText(editor.pages.map((p) => p.id), ["spa"], { signal: aborted.signal })).toBe(false);
    expect(lastMessage()).toBe("Se detuvo el reconocimiento de texto.");
    expect(mocks.stopOcr).toHaveBeenCalled();

    const later = new AbortController();
    mocks.recognizePage.mockResolvedValueOnce(ocrPage(1)).mockImplementationOnce(() => {
      setTimeout(() => later.abort(), 0);
      return new Promise(() => {});
    });
    expect(await editor.recognizeText(editor.pages.map((p) => p.id), ["spa"], { signal: later.signal })).toBe(false);
    expect(lastMessage()).toBe("Se detuvo el reconocimiento: se reconoció el texto de 1 página.");

    const notYet = new AbortController();
    mocks.recognizePage.mockResolvedValueOnce(ocrPage(0));
    expect(await editor.recognizeText([editor.pages[0].id], ["spa"], { signal: notYet.signal })).toBe(true);

    mocks.recognizePage.mockRejectedValueOnce(new Error("sin red"));
    expect(await editor.recognizeText([editor.pages[0].id], ["spa"])).toBe(false);
    expect(lastMessage()).toBe("No se pudo reconocer el texto de la página. Comprueba la conexión la primera vez que lo uses.");
  });

  it("forgets recognised text of a page", async () => {
    const pages = await open();
    editor.ocr = { [`${pages[0].sourceId}:0`]: ocrPage(1) as never };
    editor.forgetRecognisedText("nada");
    editor.forgetRecognisedText(pages[0].id);
    expect(editor.ocr).toEqual({});
    editor.sources.clear();
    expect(await editor.recognizeText([pages[0].id], ["spa"])).toBe(true);
  });

  it("checks certificates before signing", async () => {
    const { CertificateError } = await import("./export/sign");
    mocks.readPkcs12.mockReturnValueOnce({ certificate: {} });
    mocks.describeCertificate.mockReturnValueOnce({ name: "Ana" });
    expect(await editor.checkCertificate(new Uint8Array(), "x")).toEqual({ summary: { name: "Ana" } });
    mocks.readPkcs12.mockImplementationOnce(() => {
      throw new CertificateError("password");
    });
    expect(await editor.checkCertificate(new Uint8Array(), "x")).toEqual({ error: "La contraseña del certificado no es correcta." });
    mocks.readPkcs12.mockImplementationOnce(() => {
      throw new Error("raro");
    });
    expect(await editor.checkCertificate(new Uint8Array(), "x")).toEqual({ error: "El archivo no es un certificado PKCS#12 (.p12 o .pfx) válido." });
  });
});

// ── Selection, clipboard and delegated actions ──────────────────────────

describe("selection", () => {
  it("lets one page own the selection and adopts the styles of a single object", async () => {
    const pages = await open();
    const first = controller();
    const second = controller();
    const unregisterFirst = editor.registerPage(pages[0].id, first as never);
    editor.registerPage(pages[1].id, second as never);
    editor.reportSelection(pages[0].id, selectionInfo({ text: { ...editor.textStyle, fontSize: 40 }, shape: { stroke: "#123456", fill: null, strokeWidth: 2 }, highlight: "#00ff00" }));
    expect([editor.textStyle.fontSize, editor.shapeStyle.stroke, editor.highlightColor]).toEqual([40, "#123456", "#00ff00"]);
    expect(editor.selectionPage?.id).toBe(pages[0].id);
    editor.reportSelection(pages[1].id, selectionInfo({ count: 2, text: { ...editor.textStyle, fontSize: 10 } }));
    expect(first.clearSelection).toHaveBeenCalled();
    expect(editor.textStyle.fontSize).toBe(40);
    editor.reportSelection(pages[0].id, null);
    expect(editor.selection).not.toBeNull();
    editor.reportSelection(pages[1].id, null);
    expect(editor.selection).toBeNull();
    editor.reportSelection(pages[0].id, selectionInfo());
    // A page that registers again keeps its new controller.
    editor.registerPage(pages[0].id, controller() as never);
    unregisterFirst();
    expect(editor.selection).toBeNull();
    editor.reportSelection(pages[1].id, selectionInfo());
    editor.registerPage(pages[1].id, second as never)();
    expect(editor.selection).toBeNull();
  });

  it("passes actions to the page that owns the selection", async () => {
    const pages = await open();
    // Nothing selected: nothing happens.
    editor.applyTextStyle({ fontSize: 12 });
    editor.applyShapeStyle({ strokeWidth: 9 });
    editor.setHighlightColor("#ff0000");
    expect(editor.isEditingText()).toBe(false);
    expect([editor.textStyle.fontSize, editor.shapeStyle.strokeWidth, editor.highlightColor]).toEqual([12, 9, "#ff0000"]);

    const page = controller({ isEditingText: vi.fn(() => true) });
    editor.registerPage(pages[0].id, page as never);
    editor.reportSelection(pages[0].id, selectionInfo());
    editor.applyTextStyle({ fontSize: 12 });
    editor.applyShapeStyle({ strokeWidth: 9 });
    editor.setLinkTarget({ url: "https://ejemplo.es" });
    editor.setHighlightColor("#ff0000");
    editor.rotateSelection(90);
    editor.flipSelection("x");
    editor.setSelectionOpacity(0.5);
    editor.arrangeSelection("front");
    editor.alignSelection("left");
    editor.distributeSelection("vertical");
    editor.groupSelection();
    editor.ungroupSelection();
    editor.setSelectionBounds({ left: 1 }, true);
    editor.toggleLockSelection();
    editor.nudgeSelection(1, 2);
    editor.restoreOriginalText();
    await editor.duplicateSelection();
    expect(editor.isEditingText()).toBe(true);
    for (const name of ["applyTextStyle", "applyShapeStyle", "setLinkTarget", "rotateSelection", "flipSelection", "setSelectionOpacity", "arrangeSelection", "alignSelection", "distributeSelection", "groupSelection", "ungroupSelection", "setSelectionBounds", "toggleLockSelection", "nudgeSelection", "restoreOriginalText", "duplicateSelection"]) {
      expect(page[name]).toHaveBeenCalled();
    }
    expect(page.applyShapeStyle).toHaveBeenLastCalledWith({}, "#ff0000");
  });

  it("says when locked objects were not deleted", async () => {
    const pages = await open();
    const page = controller({ deleteSelection: vi.fn(() => ({ removed: 1, locked: 1 })) });
    editor.registerPage(pages[0].id, page as never);
    editor.deleteSelection();
    editor.reportSelection(pages[0].id, selectionInfo());
    editor.deleteSelection();
    expect(lastMessage()).toBe("Los objetos bloqueados no se eliminaron.");
    page.deleteSelection.mockReturnValue({ removed: 0, locked: 1 });
    editor.deleteSelection();
    expect(lastMessage()).toBe("Este objeto está bloqueado. Desbloquéalo para poder eliminarlo.");
    page.deleteSelection.mockReturnValue({ removed: 2, locked: 0 });
    notifications.items = [];
    editor.deleteSelection();
    expect(notifications.items).toEqual([]);
  });

  it("copies, cuts and pastes, shifting repeated pastes", async () => {
    const pages = await open();
    expect(editor.copySelection()).toBeNull();
    expect(await editor.pasteObjects()).toBe(false);
    const copied = { objects: [{ type: "Rect" }], text: "hola" };
    const page = controller({ copySelection: vi.fn(() => copied), deleteSelection: vi.fn(() => ({ removed: 1, locked: 0 })) });
    const other = controller();
    editor.registerPage(pages[0].id, page as never);
    editor.registerPage(pages[1].id, other as never);
    editor.reportSelection(pages[0].id, selectionInfo());
    expect(editor.copySelection()).toBe("hola");
    expect(editor.hasClipboard).toBe(true);
    expect(editor.isOwnClipboardText("hola")).toBe(true);
    expect(editor.isOwnClipboardText("otro")).toBe(false);
    editor.currentPageId = pages[0].id;
    await editor.pasteObjects();
    await editor.pasteObjects();
    expect(page.pasteObjects.mock.calls.map((call) => call[1])).toEqual([14, 28]);
    editor.currentPageId = pages[1].id;
    await editor.pasteObjects();
    expect(other.pasteObjects).toHaveBeenLastCalledWith(copied.objects, 0);
    expect(editor.cutSelection()).toBe("hola");
    expect(page.deleteSelection).toHaveBeenCalled();
    page.copySelection.mockReturnValue({ objects: [], text: "" });
    expect(editor.cutSelection()).toBeNull();
    editor.currentPageId = null;
    expect(await editor.pasteObjects()).toBe(true);
    editor.currentPageId = "nada";
    expect(await editor.pasteObjects()).toBe(false);
  });

  it("copies the selection to every other page at the same relative place", async () => {
    const pages = await open({ pages: [[600, 800], [300, 400]] });
    editor.applySelectionToAllPages();
    const page = controller({ copySelection: vi.fn(() => ({ objects: [{ type: "Rect", left: 100, top: 200 }, { type: "Rect" }], text: "" })) });
    editor.registerPage(pages[0].id, page as never);
    editor.reportSelection(pages[0].id, selectionInfo());
    editor.applySelectionToAllPages();
    expect(editor.annotations[pages[1].id].objects).toEqual([
      { type: "Rect", left: 50, top: 100 },
      { type: "Rect", left: 0, top: 0 },
    ]);
    expect(lastMessage()).toBe("Se añadió también a la otra página.");
    await editor.openFiles([pdfFile("c.pdf")]);
    editor.applySelectionToAllPages();
    expect(lastMessage()).toBe("Se añadió también a las otras 2 páginas.");
    notifications.items.at(-1)!.action!.run();
    editor.deletePages([pages[1].id, editor.pages[2].id]);
    editor.applySelectionToAllPages();
    expect(lastMessage()).toBe("El documento solo tiene una página.");
    page.copySelection.mockReturnValue({ objects: [], text: "" });
    editor.applySelectionToAllPages();
    editor.reportSelection("fuera", selectionInfo());
    editor.applySelectionToAllPages();
  });
});

// ── Saved works and projects ────────────────────────────────────────────

describe("saved works", () => {
  it("turns recovery copies on and off", async () => {
    vi.useFakeTimers();
    await open();
    editor.setRecovery(true);
    expect(mocks.setRecoveryEnabled).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Se guardará una copia del trabajo en este navegador para poder recuperarlo.");
    editor.renameDocument("otro");
    editor.renameDocument("otro más");
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.saveSession).toHaveBeenCalledTimes(2);
    editor.renameDocument("pendiente");
    editor.setRecovery(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.saveSession).toHaveBeenCalledTimes(2);
    expect(mocks.clearRecoveryCopies).toHaveBeenCalled();
    editor.setRecovery(false);
  });

  it("keeps works in the browser, warning once when storage fails", async () => {
    await editor.saveWork();
    await open();
    mocks.listSessions.mockResolvedValue([{ id: "a" }]);
    await editor.saveWork();
    expect(editor.keptWork).toBe(true);
    expect(lastMessage()).toBe("Trabajo guardado en este navegador. Lo encontrarás en la pantalla de inicio.");
    await vi.waitFor(() => expect(editor.savedWorks).toEqual([{ id: "a" }]));
    mocks.saveSession.mockRejectedValue(new Error("cuota"));
    await editor.saveWork();
    await editor.saveWork();
    expect(messages().filter((m) => m.startsWith("No se pudo guardar el trabajo en el navegador"))).toHaveLength(1);
    mocks.saveSession.mockResolvedValue(undefined);
    await editor.saveWork();
    const saved = mocks.saveSession.mock.calls.at(-1)![0] as { id: string };
    await editor.deleteWork("otro");
    expect(editor.keptWork).toBe(true);
    await editor.deleteWork(saved.id);
    expect(editor.keptWork).toBe(false);
  });

  it("saves the images the annotations use, once each, and the recognised text of its pages", async () => {
    const pages = await open();
    mocks.getImageAsset.mockImplementation((url: string) => (url.startsWith("blob:") ? { bytes: new Uint8Array([1]), mime: "image/png" } : undefined));
    editor.setPageAnnotations(pages[0].id, {
      objects: [{ type: "Image", src: "blob:a" }, { type: "Group", objects: [{ type: "Image", src: "blob:a" }, { type: "Image", src: "https://x" }] }, { type: "Rect", src: 5 }],
    });
    editor.ocr = { [`${pages[0].sourceId}:0`]: { languages: "spa", lines: [] }, "otra:0": { languages: "spa", lines: [] } };
    await editor.saveWork();
    const saved = mocks.saveSession.mock.calls.at(-1)![0] as { images: unknown[]; ocr: Record<string, unknown> };
    expect(saved.images).toHaveLength(1);
    expect(Object.keys(saved.ocr)).toEqual([`${pages[0].sourceId}:0`]);
  });

  it("opens a saved work, relinking its images", async () => {
    const { makeBlankPdf } = await import("./blankPdf");
    const bytes = pdfBytes({ pages: [[100, 100], [100, 100]] });
    mocks.loadSession.mockResolvedValueOnce(null);
    await editor.openWork("nada");
    expect(lastMessage()).toBe("No se pudo recuperar el trabajo guardado.");
    mocks.loadSession.mockResolvedValueOnce({
      version: 1,
      documentName: "Guardado",
      kept: true,
      sources: [
        { id: "s1", name: "a.pdf", bytes },
        { id: "s2", name: "Página en blanco", bytes },
        { id: "s3", name: "roto.pdf", bytes: pdfBytes({ broken: true }) },
        { id: "s4", name: "b.pdf", bytes: makeBlankPdf(1, 1) },
      ],
      pages: [
        { id: "p1", sourceId: "s1", sourceIndex: 0, width: 100, height: 100 },
        { id: "p2", sourceId: "s2", sourceIndex: 0, rotation: 90, width: 100, height: 100 },
        { id: "p3", sourceId: "s3", sourceIndex: 0, rotation: 0, width: 100, height: 100 },
        { id: "p4", sourceId: "s1", sourceIndex: 1, rotation: 0, width: 100, height: 100 },
      ],
      annotations: {
        p1: { objects: [{ type: "Image", src: "blob:vieja" }, { type: "Group", objects: [{ type: "Image", src: "blob:vieja" }] }, { type: "Rect" }] },
        p3: { objects: [] },
      },
      formValues: { s1: { campo: "x" }, s3: { campo: "y" } },
      images: [{ url: "blob:vieja", bytes: new Uint8Array([1]), mime: "image/png" }],
      ocr: { "s1:0": { languages: "spa", lines: [] }, "s3:0": { languages: "spa", lines: [] } },
    });
    await editor.openWork("w1");
    expect(lastMessage()).toBe("Se recuperó «Guardado».");
    expect(editor.pages.map((p) => [p.id, p.rotation])).toEqual([
      ["p1", 0],
      ["p2", 90],
      ["p4", 0],
    ]);
    expect(editor.annotations.p1.objects).toEqual([
      { type: "Image", src: "blob:nueva" },
      { type: "Group", objects: [{ type: "Image", src: "blob:nueva" }] },
      { type: "Rect" },
    ]);
    expect(Object.keys(editor.formValues)).toEqual(["s1"]);
    expect(Object.keys(editor.ocr)).toEqual(["s1:0"]);
    expect(editor.keptWork).toBe(true);
    expect(editor.sources.get("s2")?.generated).toBe(true);
    // Only sources whose pages are all their first page can be blank pages.
    expect(editor.sources.get("s1")?.generated).toBeUndefined();
    expect(editor.sources.get("s4")?.generated).toBe(false);
    await editor.openWork("w1");
    expect(mocks.loadSession).toHaveBeenCalledTimes(2);
  });

  it("does not open works whose pages are all gone", async () => {
    mocks.loadSession.mockResolvedValueOnce({ version: 1, documentName: "x", sources: [], pages: [{ id: "p", sourceId: "s" }], annotations: {}, images: [] });
    await editor.openWork("w");
    expect(lastMessage()).toBe("No se pudo recuperar el trabajo guardado.");
    expect(editor.hasDocument).toBe(false);
  });

  it("downloads and opens project files", async () => {
    await editor.downloadProject();
    await open();
    await editor.downloadProject();
    const [bytes, name] = mocks.downloadBytes.mock.calls.at(-1)!;
    expect(name).toBe("informe.ytapdf");
    expect(lastMessage()).toBe("Proyecto descargado. Ábrelo con «Abrir proyecto» para seguir trabajando.");
    await editor.openProject(new File([bytes as BlobPart], "p.ytapdf"));
    expect(lastMessage()).toBe("Cierra el documento abierto para abrir un proyecto.");
    editor.closeDocument();
    await editor.openProject(new File(["nada"], "malo.ytapdf"));
    expect(lastMessage()).toBe("«malo.ytapdf» no es un proyecto de ytaPDF o está dañado.");
    await editor.openProject(new File([bytes as BlobPart], "p.ytapdf"));
    expect(lastMessage()).toBe("Se abrió el proyecto «informe».");
    expect(editor.pages).toHaveLength(3);
    editor.closeDocument();
    const { writeProject } = await import("./project");
    await editor.openProject(new File([writeProject({ version: 1, savedAt: 0, documentName: "vacío", sources: [], pages: [{ id: "p", sourceId: "s" }] as never, annotations: {}, formValues: {}, images: [] }) as BlobPart], "v.ytapdf"));
    expect(lastMessage()).toBe("No se pudo recuperar el trabajo guardado.");
    editor.busy = "ocupado";
    await editor.openProject(new File([], "x.ytapdf"));
  });
});

// ── Zoom ────────────────────────────────────────────────────────────────

describe("zoom", () => {
  it("zooms within limits, by steps and to fit", async () => {
    editor.setZoom(10);
    expect(editor.zoom).toBe(4);
    editor.zoomIn();
    expect(editor.zoom).toBe(4);
    editor.setZoom(0.1);
    editor.zoomOut();
    expect(editor.zoom).toBe(0.25);
    editor.zoomIn();
    expect(editor.zoom).toBe(0.33);
    editor.zoomOut();
    expect(editor.zoom).toBe(0.25);

    editor.fitWidth();
    await editor.fitPage();
    const pages = await open();
    const scrollToPage = vi.fn();
    const fit = { scrollToPage, fitWidth: vi.fn(() => 1.5), fitPage: vi.fn(() => 0.8) };
    editor.registerViewport(fit);
    editor.fitWidth();
    expect(editor.zoom).toBe(1.5);
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
    await editor.fitPage();
    expect(editor.zoom).toBe(0.8);
    expect(scrollToPage).toHaveBeenCalledWith(pages[0].id, false);
    editor.currentPageId = null;
    await editor.fitPage();
    expect(fit.fitPage).toHaveBeenLastCalledWith(pages[0].id);
    fit.fitWidth.mockReturnValue(null as never);
    fit.fitPage.mockReturnValue(null as never);
    editor.fitWidth();
    await editor.fitPage();
    expect(editor.zoom).toBe(0.8);
  });
});

// ── Corners of the store ────────────────────────────────────────────────

describe("less common paths", () => {
  it("saves as a chosen file without a password, compressed", async () => {
    await open();
    mocks.pickSaveLocation.mockResolvedValueOnce({ name: "x.pdf" });
    expect(await editor.saveAs({ fileName: "x", compression: "strong" })).toBe(true);
    expect(lastMessage()).toBe("Se guardó «x.pdf».");
    expect(mocks.exportDocument.mock.calls.at(-1)![0]).toMatchObject({ compression: { quality: 0.6, maxDpi: 110 } });
  });

  it("leaves bookmarks of pages not exported out of the outline", async () => {
    const outline = [{ title: "Capítulo", dest: [{ num: 1 }, { name: "Fit" }], items: [] }];
    const pages = await open({ pages: [[600, 800], [600, 800]], outline });
    await vi.waitFor(() => expect(editor.bookmarks).toHaveLength(1));
    await editor.exportPages([pages[0].id]);
    expect(mocks.exportDocument.mock.calls.at(-1)![0]).toMatchObject({ outline: [] });
  });

  it("reports bookmarks it cannot read", async () => {
    await open({ outline: [{ title: 5, dest: null, items: [] }] });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("No se pudieron leer los marcadores:", expect.any(Error)));
  });

  it("skips crops that miss a page and keeps annotations when nothing moves", async () => {
    const pages = await open({ pages: [[600, 800], [350, 800]] });
    editor.setPageAnnotations(pages[1].id, { objects: [{ type: "Rect", left: 5, top: 5 }] });
    // Wider than the first page: on the narrow page it falls beside it.
    editor.pendingCrop = { pageId: pages[0].id, rect: { x: 400, y: 10, width: 300, height: 500 } };
    await editor.applyCrop("all");
    expect(lastMessage()).toBe("Página recortada.");
    expect(editor.pages[1].crop).toBeUndefined();
    editor.pendingCrop = { pageId: pages[1].id, rect: { x: 0, y: 0, width: 200, height: 300 } };
    await editor.applyCrop("page");
    expect(editor.annotations[pages[1].id].objects).toEqual([{ type: "Rect", left: 5, top: 5 }]);
  });

  it("does not reverse fewer than two pages", async () => {
    const pages = await open();
    editor.reversePages(["x", "y"]);
    editor.reversePages([pages[0].id, "y"]);
    expect(editor.pages).toEqual(pages);
  });

  it("stops recognising text when asked between reporting progress and starting", async () => {
    await open({ pages: [[1, 1]] });
    const controller = new AbortController();
    mocks.recognizePage.mockImplementation(() => new Promise(() => {}));
    const result = await editor.recognizeText([editor.pages[0].id], ["spa"], { signal: controller.signal, onProgress: () => controller.abort() });
    expect(result).toBe(false);
  });

  it("does not create a blank document when it does not open", async () => {
    mocks.openPdf.mockRejectedValueOnce(new PasswordCancelledError());
    await editor.createBlankDocument();
    expect(editor.hasDocument).toBe(false);
  });

  it("cancels a pending autosave when the document closes", async () => {
    vi.useFakeTimers();
    state.recovery = true;
    vi.resetModules();
    ({ editor } = await import("./editor.svelte"));
    await open();
    editor.renameDocument("cambio");
    editor.closeDocument();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it("gives new content to the selection's page, or to any page, when none is in view", async () => {
    const pages = await open();
    const page = controller();
    editor.registerPage(pages[1].id, page as never);
    editor.currentPageId = null;
    editor.addTextFromClipboard("hola");
    expect(page.addText).toHaveBeenCalledWith("hola");
    editor.reportSelection(pages[1].id, selectionInfo());
    editor.addTextFromClipboard("otra");
    expect(page.addText).toHaveBeenLastCalledWith("otra");
    // Unregistering another page leaves the selection alone.
    editor.registerPage(pages[0].id, controller() as never)();
    expect(editor.selection).not.toBeNull();
  });

  it("places photo signatures at a default size when there are no pages", async () => {
    const page = controller();
    editor.registerPage("suelta", page as never);
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["x"]) })));
    await editor.insertSignature({ image: "data:", width: 1, height: 1 });
    expect(page.addImage).toHaveBeenLastCalledWith("blob:imagen", { width: 220 });
  });

  it("pastes nowhere when no page is in view or selected", async () => {
    const pages = await open();
    const page = controller({ copySelection: vi.fn(() => ({ objects: [{ type: "Rect" }], text: "" })) });
    editor.registerPage(pages[0].id, page as never);
    editor.reportSelection(pages[0].id, selectionInfo());
    editor.copySelection();
    editor.reportSelection(pages[0].id, null);
    editor.currentPageId = null;
    expect(await editor.pasteObjects()).toBe(false);
  });

  it("opens works saved before form values and recognised text were kept", async () => {
    mocks.loadSession.mockResolvedValueOnce({
      version: 1,
      documentName: "Antiguo",
      sources: [{ id: "s1", name: "a.pdf", bytes: pdfBytes() }],
      pages: [{ id: "p1", sourceId: "s1", sourceIndex: 0, rotation: 0, width: 600, height: 800 }],
      annotations: {},
      images: [],
    });
    await editor.openWork("viejo");
    expect(editor.formValues).toEqual({});
    expect(editor.ocr).toEqual({});
    expect(editor.decorations).toBeNull();
  });
});
