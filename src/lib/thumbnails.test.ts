// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderPage: vi.fn(),
  preview: vi.fn(),
  syncForms: vi.fn(async () => {}),
  nativeSpecsFromData: vi.fn(async () => [{ id: "n" }]),
  ensureFontsFor: vi.fn(async () => {}),
}));

vi.mock("./pdfjs", () => ({
  renderPage: mocks.renderPage,
  viewportOf: () => ({ transform: [1, 0, 0, -1, 0, 100] }),
}));
vi.mock("./pdfText/service", () => ({
  specKey: (specs: unknown) => JSON.stringify(specs),
  textEditing: { preview: mocks.preview, syncForms: mocks.syncForms },
}));
vi.mock("./embeddedFonts", () => ({ ensureFontsFor: mocks.ensureFontsFor }));
vi.mock("./nativeText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nativeText")>()),
  nativeSpecsFromData: mocks.nativeSpecsFromData,
}));

const thumbnails = await import("./thumbnails");

const page = { id: "p", sourceId: "s", sourceIndex: 0, width: 100, height: 50, rotation: 0 } as never;
const proxy = { id: "proxy" };
const source = { id: "s", pdf: { getPage: vi.fn(async () => proxy) } } as never;
const native = { type: "NativeLine", ytaNative: {} };
const rect = { type: "Rect", width: 10, height: 10, fill: "#f00" };

/** A real canvas posing as a bitmap, so it can be drawn. */
function bitmap(width = 200, height = 100) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return Object.assign(canvas, { close: vi.fn() });
}

beforeEach(() => {
  thumbnails.clearThumbnailCache();
  mocks.renderPage.mockReset();
  mocks.renderPage.mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  mocks.preview.mockReset();
  mocks.preview.mockImplementation(() => ({ pdf: Promise.resolve({ getPage: async () => ({ id: "preview" }) }), release: vi.fn() }));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
});

afterEach(() => vi.unstubAllGlobals());

const request = (changes: Record<string, unknown> = {}) => ({
  source,
  page,
  cssWidth: 100,
  annotations: undefined,
  formRevision: 0,
  formValues: {},
  signal: new AbortController().signal,
  ...changes,
});

describe("page specs", () => {
  it("has specs only for pages with native text", async () => {
    expect(await thumbnails.pageSpecs(source, page, undefined)).toEqual([]);
    expect(await thumbnails.pageSpecs(source, page, { version: "7", objects: [rect] })).toEqual([]);
    expect(await thumbnails.pageSpecs(source, page, { version: "7", objects: [native] })).toEqual([{ id: "n" }]);
  });

  it("renders the original page without specs and a preview with them", async () => {
    const plain = await thumbnails.renderablePage(source, page, [], {});
    expect(plain.proxy).toBe(proxy);
    plain.done();
    const edited = await thumbnails.renderablePage(source, page, [{ id: "n" } as never], { campo: "x" });
    expect(edited.proxy).toEqual({ id: "preview" });
    expect(mocks.syncForms).toHaveBeenCalled();
  });

  it("releases previews that fail", async () => {
    const release = vi.fn();
    mocks.preview.mockReturnValueOnce({ pdf: Promise.reject(new Error("roto")), release });
    await expect(thumbnails.renderablePage(source, page, [{ id: "n" } as never], {})).rejects.toThrow("roto");
    expect(release).toHaveBeenCalled();
  });

  it("removes native text from annotations", () => {
    expect(thumbnails.withoutNativeText({ version: "7", objects: [native, rect] }).objects).toEqual([rect]);
  });
});

describe("thumbnails", () => {
  it("renders once per size and edit, painting annotations on top", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    const canvas = document.createElement("canvas");
    await thumbnails.renderThumbnail(canvas, request({ annotations: { version: "7", objects: [rect] } }) as never);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    expect(mocks.ensureFontsFor).toHaveBeenCalled();
    await thumbnails.renderThumbnail(canvas, request() as never);
    expect(mocks.renderPage).toHaveBeenCalledTimes(1);
    // Edited text and cropped pages make other bitmaps.
    await thumbnails.renderThumbnail(canvas, request({ annotations: { version: "7", objects: [native] }, page: { ...(page as object), crop: [0, 0, 10, 10] } }) as never);
    expect(mocks.renderPage).toHaveBeenCalledTimes(2);
  });

  it("stops when asked to, at each step", async () => {
    vi.stubGlobal("devicePixelRatio", 0);
    const canvas = document.createElement("canvas");
    const aborted = new AbortController();
    aborted.abort();
    await thumbnails.renderThumbnail(canvas, request({ signal: aborted.signal }) as never);
    expect(mocks.renderPage).not.toHaveBeenCalled();

    // Aborted while the page was being prepared.
    const late = new AbortController();
    mocks.preview.mockImplementationOnce(() => ({
      pdf: Promise.resolve({ getPage: async () => (late.abort(), { id: "preview" }) }),
      release: vi.fn(),
    }));
    await thumbnails.renderThumbnail(canvas, request({ signal: late.signal, annotations: { version: "7", objects: [native] }, cssWidth: 120 }) as never);
    expect(mocks.renderPage).not.toHaveBeenCalled();

    // Aborted while rendering: the render is cancelled.
    const rendering = new AbortController();
    const cancel = vi.fn();
    mocks.renderPage.mockImplementationOnce(() => ({
      promise: new Promise<void>((resolve) => setTimeout(() => (rendering.abort(), resolve()), 0)),
      cancel,
    }));
    await thumbnails.renderThumbnail(canvas, request({ signal: rendering.signal, cssWidth: 130 }) as never);
    expect(cancel).toHaveBeenCalled();
    expect(canvas.width).not.toBe(260);
  });

  it("stops after painting the annotations when aborted meanwhile", async () => {
    const canvas = document.createElement("canvas");
    const controller = new AbortController();
    mocks.ensureFontsFor.mockImplementationOnce(async () => controller.abort());
    await thumbnails.renderThumbnail(canvas, request({ signal: controller.signal, cssWidth: 140, annotations: { version: "7", objects: [rect] } }) as never);
    expect(canvas.width).toBe(300);
  });

  it("gives up without a 2D context and evicts old bitmaps", async () => {
    const canvas = document.createElement("canvas");
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValueOnce(null);
    await thumbnails.renderThumbnail(canvas, request({ cssWidth: 150 }) as never);
    expect(canvas.width).toBe(300);
    getContext.mockRestore();

    const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      const made = bitmap(2, 2);
      bitmaps.push(made);
      return made;
    }));
    for (let i = 0; i < 152; i++) await thumbnails.renderThumbnail(canvas, request({ cssWidth: 200 + i }) as never);
    expect(bitmaps[0].close).toHaveBeenCalled();
    expect(bitmaps.at(-1)!.close).not.toHaveBeenCalled();
    thumbnails.clearThumbnailCache();
    expect(bitmaps.at(-1)!.close).toHaveBeenCalled();
  });
});
