import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSpec } from "./types";

const mocks = vi.hoisted(() => ({
  openDerivedPdf: vi.fn(),
  syncFormStorage: vi.fn(async () => {}),
  embeddedFontBytes: vi.fn(async (family: string, variant: string) => new TextEncoder().encode(`${family}:${variant}`)),
}));

vi.mock("../pdfjs", () => ({ openDerivedPdf: mocks.openDerivedPdf, syncFormStorage: mocks.syncFormStorage }));
vi.mock("../embeddedFonts", () => ({ embeddedFontBytes: mocks.embeddedFontBytes }));

interface Message {
  id: number;
  type: string;
  [key: string]: unknown;
}

/** A worker that answers each request on the next tick, as `answer` says. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static answer: (message: Message) => { result?: unknown; error?: string } | null = () => ({ result: null });
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly messages: Message[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Message) {
    this.messages.push(message);
    const answer = FakeWorker.answer(message);
    if (answer) setTimeout(() => this.onmessage?.({ data: { id: message.id, ...answer } }), 0);
  }
}

const source = (id = "s") => ({ id, bytes: new Uint8Array([1]), password: undefined }) as never;
const spec = (runs: NativeSpec["runs"] = []): NativeSpec => ({ id: "x", erase: [], insertAfter: "end", matrix: [1, 0, 0, 1, 0, 0], renderMode: 0, runs, underlines: [] });
const fallbackRun = (family: string, weight = "normal") => ({
  font: { kind: "fallback" as const, family, weight, style: "normal" },
  size: 10,
  color: { space: "gray" as const, components: [0] },
  glyphs: [],
});

let textEditing: typeof import("./service").textEditing;
let specKey: typeof import("./service").specKey;

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.answer = (message) => {
    if (message.type === "derive") return { result: { bytes: new Uint8Array([9]), failed: [], unsupported: [] } };
    if (message.type === "analyze") return { result: { lines: [message.pageIndex] } };
    return { result: null };
  };
  vi.stubGlobal("Worker", FakeWorker);
  mocks.openDerivedPdf.mockReset();
  mocks.openDerivedPdf.mockImplementation(async () => ({ loadingTask: { destroy: vi.fn(async () => {}) } }));
  mocks.embeddedFontBytes.mockClear();
  ({ textEditing, specKey } = await import("./service"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("spec keys", () => {
  it("are equal for equal specs and differ otherwise", () => {
    expect(specKey([spec()])).toBe(specKey([spec()]));
    expect(specKey(spec())).not.toBe(specKey([spec()]));
  });
});

describe("analysis", () => {
  it("opens each document once and analyses each page once", async () => {
    expect(await textEditing.analyze(source(), 0)).toEqual({ lines: [0] });
    await textEditing.analyze(source(), 0);
    await textEditing.analyze(source(), 1);
    const types = FakeWorker.instances[0].messages.map((m) => m.type);
    expect(types).toEqual(["open", "analyze", "analyze"]);
  });

  it("forgets failed opens and analyses so they can be tried again", async () => {
    FakeWorker.answer = (message) => ({ error: `falló ${message.type}` });
    await expect(textEditing.analyze(source(), 0)).rejects.toThrow("falló open");
    FakeWorker.answer = (message) => (message.type === "analyze" ? { error: "falló analyze" } : { result: null });
    await expect(textEditing.analyze(source(), 0)).rejects.toThrow("falló analyze");
    FakeWorker.answer = () => ({ result: { lines: [] } });
    expect(await textEditing.analyze(source(), 0)).toEqual({ lines: [] });
  });

  it("ignores answers to requests it did not make", async () => {
    await textEditing.analyze(source(), 0);
    expect(() => FakeWorker.instances[0].onmessage?.({ data: { id: 999, result: null } })).not.toThrow();
    // Later requests are still matched with their own answers.
    expect(await textEditing.analyze(source(), 5)).toEqual({ lines: [5] });
  });

  it("restarts after the worker stops, failing what was pending", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    FakeWorker.answer = () => null;
    const pending = textEditing.analyze(source(), 0);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    FakeWorker.instances[0].onerror?.({ message: "sin memoria" });
    await expect(pending).rejects.toThrow("El analizador de texto se reinició.");
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("El analizador de texto se detuvo:", "sin memoria");
    FakeWorker.answer = () => ({ result: { lines: [] } });
    await textEditing.analyze(source(), 0);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe("previews", () => {
  it("sends the embedded fallback fonts the specs need, once each", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    FakeWorker.answer = (message) =>
      message.type === "derive" ? { result: { bytes: new Uint8Array([1]), failed: ["x"], unsupported: [] } } : { result: null };
    const runs = [fallbackRun('"Noto Sans"'), fallbackRun('"Noto Sans"'), fallbackRun("Helvetica"), fallbackRun(""), { ...fallbackRun("x"), font: { kind: "original" as const, sample: "0:0", key: "k" } }];
    const handle = textEditing.preview(source(), 0, [spec(runs)]);
    await handle.pdf;
    const derive = FakeWorker.instances[0].messages.find((m) => m.type === "derive")!;
    expect(Object.keys(derive.fonts as object)).toEqual(["noto-sans:regular"]);
    expect(mocks.embeddedFontBytes).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Algunos textos editados no se pudieron aplicar:", ["x"]);
    handle.release();
  });

  it("shares previews while in use and drops them a while after", async () => {
    vi.useFakeTimers();
    const first = textEditing.preview(source(), 0, [spec()]);
    const second = textEditing.preview(source(), 0, [spec()]);
    expect(second.pdf).toBe(first.pdf);
    await vi.runAllTimersAsync();
    const pdf = await first.pdf;
    first.release();
    first.release();
    second.release();
    // Used again before it expires: kept.
    const third = textEditing.preview(source(), 0, [spec()]);
    expect(third.pdf).toBe(first.pdf);
    third.release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((pdf as unknown as { loadingTask: { destroy: ReturnType<typeof vi.fn> } }).loadingTask.destroy).toHaveBeenCalled();
    const fourth = textEditing.preview(source(), 0, [spec()]);
    expect(fourth.pdf).not.toBe(first.pdf);
  });

  it("keeps only a few unused previews", async () => {
    vi.useFakeTimers();
    const handles = Array.from({ length: 10 }, (_, i) => textEditing.preview(source(), i, [spec()]));
    await vi.runAllTimersAsync();
    const pdfs = await Promise.all(handles.map((h) => h.pdf));
    for (const handle of handles) handle.release();
    await vi.advanceTimersByTimeAsync(0);
    const destroyed = pdfs.filter((pdf) => (pdf as unknown as { loadingTask: { destroy: ReturnType<typeof vi.fn> } }).loadingTask.destroy.mock.calls.length > 0);
    expect(destroyed).toHaveLength(2);
  });

  it("forgets previews that failed, even with their timer pending", async () => {
    vi.useFakeTimers();
    mocks.openDerivedPdf.mockRejectedValueOnce(new Error("roto"));
    const handle = textEditing.preview(source(), 0, [spec()]);
    handle.release();
    await vi.runAllTimersAsync();
    await expect(handle.pdf).rejects.toThrow("roto");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(textEditing.preview(source(), 0, [spec()]).pdf).not.toBe(handle.pdf);
  });

  it("does not drop a preview taken again under the same key", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    mocks.openDerivedPdf.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const failing = textEditing.preview(source(), 0, [spec()]);
    failing.release();
    await vi.advanceTimersByTimeAsync(1);
    fail(new Error("roto"));
    await expect(failing.pdf).rejects.toThrow("roto");
    const again = textEditing.preview(source(), 0, [spec()]);
    await vi.advanceTimersByTimeAsync(30_000);
    const pdf = await again.pdf;
    expect((pdf as unknown as { loadingTask: { destroy: ReturnType<typeof vi.fn> } }).loadingTask.destroy).not.toHaveBeenCalled();
  });

  it("drops every preview on reset, even those in use, and survives failed destroys", async () => {
    vi.useFakeTimers();
    mocks.openDerivedPdf.mockImplementation(async () => ({ loadingTask: { destroy: vi.fn(async () => Promise.reject(new Error("ya"))) } }));
    const inUse = textEditing.preview(source(), 0, [spec()]);
    await vi.runAllTimersAsync();
    await inUse.pdf;
    textEditing.reset();
    await vi.runAllTimersAsync();
    textEditing.reset();
    expect(textEditing.preview(source(), 0, [spec()]).pdf).not.toBe(inUse.pdf);
  });
});

describe("form values in previews", () => {
  it("syncs values only when they change", async () => {
    const pdf = {} as never;
    const values = { campo: "a" };
    await textEditing.syncForms(pdf, values);
    await textEditing.syncForms(pdf, values);
    await textEditing.syncForms(pdf, { campo: "b" });
    expect(mocks.syncFormStorage.mock.calls).toEqual([
      [pdf, values, {}],
      [pdf, { campo: "b" }, values],
    ]);
  });
});
