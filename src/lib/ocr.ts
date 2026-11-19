import type { PDFPageProxy } from "pdfjs-dist";
import type { Worker as TesseractWorker } from "tesseract.js";
import { invert, applyToPoint, type Matrix } from "./geometry";
import type { OcrLine, OcrPage, OcrWord } from "./ocrText";
import { MAX_CANVAS_PIXELS } from "./pdfjs";
import type { Point } from "./polygon";

/**
 * Local OCR with Tesseract (WebAssembly). The engine, its worker and the
 * language data are served from this site (see `tesseractAssets` in
 * vite.config.ts), so recognising a page never sends anything elsewhere.
 */

export const OCR_LANGUAGES = [
  { code: "spa", label: "Español" },
  { code: "eng", label: "English" },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]["code"];

const BASE = "/tesseract";
/** Rendering resolution for recognition: Tesseract works best around 300 ppp. */
const OCR_DPI = 300;
/** Words recognised with less confidence than this (0–100) are usually noise from pictures. */
const MIN_CONFIDENCE = 35;

export interface OcrProgress {
  /** 0–1 for the page being recognised. */
  progress: number;
  status: "loading" | "recognizing";
}

let current: { languages: string; worker: Promise<TesseractWorker> } | null = null;
let progressListener: ((progress: OcrProgress) => void) | null = null;

async function workerFor(languages: OcrLanguage[]): Promise<TesseractWorker> {
  const key = [...languages].sort((a, b) => a.localeCompare(b)).join("+");
  if (current?.languages === key) return current.worker;
  if (current) void current.worker.then((worker) => worker.terminate()).catch(() => undefined);
  const worker = (async () => {
    const { createWorker, OEM } = await import("tesseract.js");
    // A plain copy: reactive arrays (proxies) cannot be sent to a worker.
    return createWorker([...languages], OEM.LSTM_ONLY, {
      workerPath: `${BASE}/worker.min.js`,
      corePath: `${BASE}/core`,
      langPath: `${BASE}/lang`,
      gzip: true,
      // The service worker keeps these files; no second copy in IndexedDB.
      cacheMethod: "none",
      workerBlobURL: false,
      logger: (message) => {
        const status = message.status === "recognizing text" ? "recognizing" : "loading";
        progressListener?.({ progress: Number(message.progress) || 0, status });
      },
    });
  })();
  current = { languages: key, worker };
  worker.catch(() => {
    if (current?.worker === worker) current = null;
  });
  return worker;
}

/** Stops the engine and frees its memory. */
export async function stopOcr(): Promise<void> {
  const worker = current?.worker;
  current = null;
  if (worker) await worker.then((w) => w.terminate()).catch(() => undefined);
}

/**
 * Recognises the text of a page of a source document. Positions are given
 * in the page's PDF user space, so they stay right when the page is later
 * rotated or cropped in the editor.
 */
export async function recognizePage(
  proxy: PDFPageProxy,
  languages: OcrLanguage[],
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrPage> {
  const worker = await workerFor(languages);
  const base = proxy.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
  const viewport = proxy.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo preparar la página para reconocer el texto.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await proxy.render({ canvas, viewport }).promise;

  progressListener = onProgress ?? null;
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const toUser = invert(viewport.transform as Matrix);
    return { languages: [...languages].join("+"), lines: toOcrLines(data.blocks ?? [], toUser) };
  } finally {
    progressListener = null;
    canvas.width = 0;
    canvas.height = 0;
  }
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RawBlock {
  paragraphs: { lines: { bbox: Box; words: { text: string; confidence: number; bbox: Box }[] }[] }[];
}

/** Bottom-left, bottom-right, top-right, top-left of a pixel box (y down), in user space. */
function quadOf(box: Box, toUser: Matrix): Point[] {
  return [
    applyToPoint(toUser, box.x0, box.y1),
    applyToPoint(toUser, box.x1, box.y1),
    applyToPoint(toUser, box.x1, box.y0),
    applyToPoint(toUser, box.x0, box.y0),
  ];
}

export function toOcrLines(blocks: RawBlock[], toUser: Matrix): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const line of blocks.flatMap((block) => block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? [])) {
    const words: OcrWord[] = (line.words ?? [])
      .filter((word) => word.text.trim() !== "" && word.confidence >= MIN_CONFIDENCE)
      .map((word) => ({ text: word.text.trim(), quad: quadOf(word.bbox, toUser) }));
    if (words.length > 0) lines.push({ words, quad: quadOf(line.bbox, toUser) });
  }
  return lines;
}
