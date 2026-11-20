import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tesseract = vi.hoisted(() => ({
  createWorker: vi.fn(),
  options: [] as { logger: (message: { status: string; progress: unknown }) => void }[],
}));

vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: tesseract.createWorker,
}));
vi.mock("./pdfjs", () => ({ MAX_CANVAS_PIXELS: 16_777_216 }));

const { recognizePage, stopOcr, toOcrLines } = await import("./ocr");

interface FakeWorker {
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function fakeWorker(blocks: unknown = []): FakeWorker {
  return {
    recognize: vi.fn(async () => ({ data: { blocks } })),
    terminate: vi.fn(async () => undefined),
  };
}

/** A PDF.js page of 100 × 50 points that "renders" instantly. */
const proxy = () =>
  ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 50 * scale, transform: [scale, 0, 0, -scale, 0, 50 * scale] }),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  }) as never;

function stubDocument(context: object | null = { fillRect: vi.fn(), fillStyle: "" }) {
  const canvas = { width: 0, height: 0, getContext: () => context };
  vi.stubGlobal("document", { createElement: () => canvas });
  return canvas;
}

beforeEach(() => {
  tesseract.createWorker.mockReset();
  tesseract.options.length = 0;
  tesseract.createWorker.mockImplementation(async (_languages: string[], _oem: number, options: (typeof tesseract.options)[number]) => {
    tesseract.options.push(options);
    return fakeWorker([
      {
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
                words: [
                  { text: " Hola ", confidence: 90, bbox: { x0: 0, y0: 0, x1: 40, y1: 20 } },
                  { text: "ruido", confidence: 10, bbox: { x0: 50, y0: 0, x1: 90, y1: 20 } },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });
});

afterEach(async () => {
  await stopOcr();
  vi.unstubAllGlobals();
});

describe("recognising pages", () => {
  it("renders the page on white and maps the words back to the page", async () => {
    const canvas = stubDocument();
    const page = await recognizePage(proxy(), ["spa", "eng"]);
    expect(page.languages).toBe("spa+eng");
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0].words.map((w) => w.text)).toEqual(["Hola"]);
    // 300 dpi: 100 points are 416 pixels, and the canvas is released afterwards.
    expect(canvas.width).toBe(0);
    expect(tesseract.createWorker).toHaveBeenCalledWith(["spa", "eng"], 1, expect.objectContaining({ workerPath: "/tesseract/worker.min.js" }));
  });

  it("reports progress while recognising, and only then", async () => {
    stubDocument();
    const onProgress = vi.fn();
    const worker = fakeWorker();
    tesseract.createWorker.mockImplementationOnce(async (_l: string[], _o: number, options: (typeof tesseract.options)[number]) => {
      tesseract.options.push(options);
      worker.recognize.mockImplementation(async () => {
        options.logger({ status: "recognizing text", progress: 0.5 });
        options.logger({ status: "loading language", progress: "x" });
        return { data: {} };
      });
      return worker;
    });
    const page = await recognizePage(proxy(), ["spa"], onProgress);
    expect(page.lines).toEqual([]);
    expect(onProgress.mock.calls).toEqual([[{ progress: 0.5, status: "recognizing" }], [{ progress: 0, status: "loading" }]]);
    tesseract.options[0].logger({ status: "recognizing text", progress: 1 });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("keeps one worker per set of languages, replacing it when they change", async () => {
    stubDocument();
    await recognizePage(proxy(), ["eng", "spa"]);
    await recognizePage(proxy(), ["spa", "eng"]);
    expect(tesseract.createWorker).toHaveBeenCalledTimes(1);
    const first = await tesseract.createWorker.mock.results[0].value;
    first.terminate.mockRejectedValueOnce(new Error("ya terminado"));
    await recognizePage(proxy(), ["spa"]);
    expect(tesseract.createWorker).toHaveBeenCalledTimes(2);
    expect(first.terminate).toHaveBeenCalled();
  });

  it("forgets a worker that could not start, unless another one replaced it", async () => {
    stubDocument();
    tesseract.createWorker.mockRejectedValueOnce(new Error("sin red"));
    await expect(recognizePage(proxy(), ["spa"])).rejects.toThrow("sin red");
    await recognizePage(proxy(), ["spa"]);
    expect(tesseract.createWorker).toHaveBeenCalledTimes(2);

    let fail!: (error: Error) => void;
    tesseract.createWorker.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const pending = recognizePage(proxy(), ["eng"]);
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const replacement = recognizePage(proxy(), ["spa", "eng"]);
    fail(new Error("tarde"));
    await expect(pending).rejects.toThrow("tarde");
    await replacement;
    await recognizePage(proxy(), ["spa", "eng"]);
    expect(tesseract.createWorker).toHaveBeenCalledTimes(4);
  });

  it("fails when the canvas has no 2D context", async () => {
    stubDocument(null);
    await expect(recognizePage(proxy(), ["spa"])).rejects.toThrow("No se pudo preparar la página para reconocer el texto.");
  });

  it("stops without a worker, and when stopping fails", async () => {
    await expect(stopOcr()).resolves.toBeUndefined();
    stubDocument();
    await recognizePage(proxy(), ["spa"]);
    const worker = await tesseract.createWorker.mock.results[0].value;
    worker.terminate.mockRejectedValueOnce(new Error("no responde"));
    await expect(stopOcr()).resolves.toBeUndefined();
  });
});

describe("recognised lines", () => {
  it("tolerates results without paragraphs, lines or words", () => {
    const identity = [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number];
    expect(toOcrLines([{} as never, { paragraphs: [{} as never, { lines: [{ bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } } as never] }] }], identity)).toEqual([]);
  });
});
