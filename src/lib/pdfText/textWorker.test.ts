import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { TextDocument } from "./textDocument";

const posted: { message: WorkerResponse; transfer?: unknown[] }[] = [];
let handle: (event: { data: WorkerRequest }) => Promise<void>;

beforeAll(async () => {
  vi.stubGlobal("postMessage", (message: WorkerResponse, transfer?: unknown[]) => posted.push({ message, transfer }));
  await import("./textWorker");
  handle = (globalThis as unknown as { onmessage: typeof handle }).onmessage;
});

afterAll(() => vi.unstubAllGlobals());

async function send(request: WorkerRequest): Promise<{ message: WorkerResponse; transfer?: unknown[] } | undefined> {
  const before = posted.length;
  await handle({ data: request });
  return posted.length > before ? posted.at(-1) : undefined;
}

async function pdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText("Hola", { x: 20, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
}

describe("text worker", () => {
  it("opens documents once, analyses and previews their pages, and closes them", async () => {
    const bytes = await pdfBytes();
    const open = vi.spyOn(TextDocument, "open");
    expect((await send({ id: 1, type: "open", sourceId: "a", bytes }))?.message).toEqual({ id: 1, result: null });
    await send({ id: 2, type: "open", sourceId: "a", bytes });
    expect(open).toHaveBeenCalledTimes(1);

    const analysis = await send({ id: 3, type: "analyze", sourceId: "a", pageIndex: 0 });
    expect((analysis?.message.result as { lines: unknown[] }).lines).toHaveLength(1);

    const derived = await send({ id: 4, type: "derive", sourceId: "a", pageIndex: 0, specs: [], fonts: {} });
    expect((derived?.message.result as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array);
    expect(derived?.transfer).toHaveLength(1);

    expect((await send({ id: 5, type: "close", sourceId: "a" }))?.message).toEqual({ id: 5, result: null });
    open.mockRestore();
  });

  it("reports errors, forgetting documents that failed to open", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send({ id: 6, type: "analyze", sourceId: "nada", pageIndex: 0 }))?.message).toEqual({
      id: 6,
      error: "El documento no está abierto en el analizador de texto.",
    });
    expect((await send({ id: 7, type: "open", sourceId: "b", bytes: new Uint8Array([1, 2, 3]) }))?.message.error).toBeTruthy();
    expect((await send({ id: 8, type: "derive", sourceId: "b", pageIndex: 0, specs: [], fonts: {} }))?.message.error).toBe(
      "El documento no está abierto en el analizador de texto.",
    );
    const open = vi.spyOn(TextDocument, "open").mockRejectedValueOnce("texto suelto");
    expect((await send({ id: 9, type: "open", sourceId: "c", bytes: new Uint8Array() }))?.message).toEqual({ id: 9, error: "texto suelto" });
    open.mockRestore();
    errors.mockRestore();
  });

  it("ignores requests it does not know", async () => {
    expect(await send({ id: 10, type: "otra" } as never)).toBeUndefined();
  });
});
