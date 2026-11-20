import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

// Node runs the legacy build of PDF.js, with its worker loaded in-process.
vi.mock("pdfjs-dist", async () => import("pdfjs-dist/legacy/build/pdf.mjs"));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "pdfjs-dist/legacy/build/pdf.worker.mjs" }));

const pdfjs = await import("./pdfjs");
const { RenderingCancelledException } = await import("pdfjs-dist/legacy/build/pdf.mjs");

afterEach(() => vi.unstubAllGlobals());

async function pdfBytes(options: { password?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 100]);
  page.drawText("Hola", { x: 10, y: 50, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  if (options.password) doc.encrypt({ userPassword: options.password, ownerPassword: options.password });
  return doc.save();
}

describe("opening documents", () => {
  it("opens plain documents without asking for a password", async () => {
    const ask = vi.fn();
    const { pdf, password } = await pdfjs.openPdf(await pdfBytes(), ask);
    expect(pdf.numPages).toBe(1);
    expect(password).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect((await pdfjs.openDerivedPdf(await pdfBytes())).numPages).toBe(1);
  });

  it("asks for the password again when it is wrong", async () => {
    const ask = vi.fn(async (incorrect: boolean) => (incorrect ? "secreto" : "otra"));
    const { password } = await pdfjs.openPdf(await pdfBytes({ password: "secreto" }), ask);
    expect(password).toBe("secreto");
    expect(ask.mock.calls).toEqual([[false], [true]]);
  });

  it("stops when the user cancels and passes on other errors", async () => {
    await expect(pdfjs.openPdf(await pdfBytes({ password: "secreto" }), async () => null)).rejects.toBeInstanceOf(pdfjs.PasswordCancelledError);
    await expect(pdfjs.openPdf(new TextEncoder().encode("no es un PDF"), async () => null)).rejects.toThrow();
  });

  it("tells cancelled renders from other errors", () => {
    expect(pdfjs.isRenderCancelled(new RenderingCancelledException("cancelado"))).toBe(true);
    expect(pdfjs.isRenderCancelled(new Error("otro"))).toBe(false);
  });
});

describe("viewports and rendering", () => {
  it("adds the editor's rotation and crops to the kept area", async () => {
    const { pdf } = await pdfjs.openPdf(await pdfBytes(), vi.fn());
    const page = await pdf.getPage(1);
    expect(pdfjs.viewportOf(page, 1).width).toBe(200);
    expect(pdfjs.viewportOf(page, 1, 90).width).toBe(100);
    const cropped = pdfjs.viewportOf(page, 2, { rotation: 0, crop: [0, 0, 50, 20] });
    expect([cropped.width, cropped.height]).toEqual([100, 40]);
    const withoutUnit = { rotate: 0, getViewport: page.getViewport.bind(page) };
    expect(pdfjs.viewportOf(withoutUnit as never, 1, { crop: [0, 0, 10, 10] }).width).toBe(10);
  });

  it("renders at the device's pixel ratio, within the canvas limit", async () => {
    const { pdf } = await pdfjs.openPdf(await pdfBytes(), vi.fn());
    const real = await pdf.getPage(1);
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = { rotate: 0, userUnit: 1, getViewport: real.getViewport.bind(real), render };
    const canvas = { width: 0, height: 0, style: { width: "", height: "" } };
    vi.stubGlobal("window", { devicePixelRatio: 0 });
    pdfjs.renderPage(page as never, canvas as never, 1);
    expect([canvas.width, canvas.height, canvas.style.width]).toEqual([200, 100, "200px"]);
    pdfjs.renderPage(page as never, canvas as never, 1, 2, 90);
    expect([canvas.width, canvas.height]).toEqual([200, 400]);
    // Large pages render at fewer pixels per CSS pixel to stay within the limit…
    pdfjs.renderPage(page as never, canvas as never, 20, 3);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(pdfjs.MAX_CANVAS_PIXELS);
    expect(canvas.width).toBeGreaterThan(4000);
    // …but never fewer than a quarter.
    pdfjs.renderPage(page as never, canvas as never, 1000, 3);
    expect(canvas.width).toBe(50_000);
    pdfjs.renderPage(page as never, canvas as never, 0.0001, 0.01);
    expect(canvas.width).toBe(1);
    expect(render).toHaveBeenCalledTimes(5);
  });

  it("reads each page's text once, retrying after a failure", async () => {
    const getTextContent = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValue({ items: [] });
    const page = { getTextContent } as never;
    await expect(pdfjs.pageTextContent(page)).rejects.toThrow("no");
    expect(await pdfjs.pageTextContent(page)).toEqual({ items: [] });
    await pdfjs.pageTextContent(page);
    expect(getTextContent).toHaveBeenCalledTimes(2);
  });
});

describe("form widgets", () => {
  const raw = (changes: Record<string, unknown>) => ({ id: "w", annotationType: 20, fieldName: "campo", rect: [0, 0, 10, 10], ...changes });

  it("reads text, choice, checkbox and radio widgets, skipping the rest", async () => {
    const annotations = [
      raw({ fieldType: "Tx", fieldValue: "hola", readOnly: true, multiLine: true, maxLen: 5, textAlignment: 1, defaultAppearanceData: { fontSize: 9 } }),
      raw({ fieldType: "Tx", fieldValue: 3, textAlignment: 7 }),
      raw({ fieldType: "Ch", options: [{ exportValue: "a", displayValue: "A" }], fieldValue: ["a", "b"], multiSelect: true }),
      raw({ fieldType: "Ch", fieldValue: ["b"] }),
      raw({ fieldType: "Ch", fieldValue: 7 }),
      raw({ fieldType: "Btn", checkBox: true, exportValue: "Sí", fieldValue: "Sí" }),
      raw({ fieldType: "Btn", radioButton: true, buttonValue: "uno", fieldValue: "uno" }),
      raw({ fieldType: "Btn", radioButton: true, buttonValue: "dos", fieldValue: "Off" }),
      raw({ fieldType: "Btn", radioButton: true, buttonValue: "tres", fieldValue: null }),
      raw({ fieldType: "Btn", pushButton: true }),
      raw({ fieldType: "Sig" }),
      raw({ hidden: true, fieldType: "Tx" }),
      raw({ fieldName: "", fieldType: "Tx" }),
      { id: "l", annotationType: 2, rect: [0, 0, 1, 1] },
    ];
    const page = { getAnnotations: vi.fn(async () => annotations) };
    const widgets = await pdfjs.pageWidgets(page as never);
    expect(widgets.map((w) => [w.kind, w.initialValue])).toEqual([
      ["text", "hola"],
      ["text", ""],
      ["choice", ["a", "b"]],
      ["choice", "b"],
      ["choice", "7"],
      ["checkbox", true],
      ["radio", "uno"],
      ["radio", null],
      ["radio", null],
    ]);
    expect(widgets[0]).toMatchObject({ readOnly: true, multiLine: true, maxLen: 5, textAlign: "center", fontSize: 9 });
    expect(widgets[1]).toMatchObject({ readOnly: false, maxLen: 0, textAlign: "left", fontSize: 0 });
    expect(widgets[3].options).toEqual([]);
    await pdfjs.pageWidgets(page as never);
    expect(page.getAnnotations).toHaveBeenCalledTimes(1);
    expect(await pdfjs.pageWidgets({ getAnnotations: async () => Promise.reject(new Error("no")) } as never)).toEqual([]);
  });

  it("lists the document's fields without the parent entries", async () => {
    const pdf = {
      getFieldObjects: vi.fn(async () => new Map([["nombre", [{ id: "", type: "" }, { id: "1R", type: "text" }]]])),
    };
    expect([...(await pdfjs.documentFields(pdf as never))]).toEqual([["nombre", [{ id: "1R", type: "text" }]]]);
    await pdfjs.documentFields(pdf as never);
    expect(pdf.getFieldObjects).toHaveBeenCalledTimes(1);
    expect((await pdfjs.documentFields({ getFieldObjects: async () => null } as never)).size).toBe(0);
    expect((await pdfjs.documentFields({ getFieldObjects: async () => Promise.reject(new Error("no")) } as never)).size).toBe(0);
  });

  it("writes changed values into the annotation storage", async () => {
    const storage = { setValue: vi.fn(), remove: vi.fn() };
    const pdf = {
      annotationStorage: storage,
      getFieldObjects: async () =>
        new Map(
          Object.entries({
            texto: [{ id: "t", type: "text" }],
            casilla: [{ id: "c", type: "checkbox" }],
            opcion: [{ id: "r1", type: "radiobutton", exportValues: "uno" }, { id: "r2", type: "radiobutton", exportValues: "dos" }],
            vacio: [{ id: "v", type: "text" }],
            igual: [{ id: "i", type: "text" }],
          }),
        ),
    };
    await pdfjs.syncFormStorage(pdf as never, { texto: "hola", casilla: true, opcion: "dos", vacio: null, igual: "x", falta: "y" }, { igual: "x", borrado: "z" });
    expect(storage.setValue.mock.calls).toEqual([
      ["t", { value: "hola" }],
      ["c", { value: true }],
      ["r1", { value: false }],
      ["r2", { value: true }],
      ["v", { value: "" }],
    ]);
    await pdfjs.syncFormStorage(pdf as never, {}, { texto: "hola" });
    expect(storage.remove).toHaveBeenCalledWith("t");
    await pdfjs.syncFormStorage(pdf as never, { texto: "otra" });
  });
});
