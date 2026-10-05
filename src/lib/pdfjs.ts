import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** Asset locations served locally by the `pdfjs-assets` Vite plugin. */
const assetOptions = {
  cMapUrl: `${ASSET_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
  wasmUrl: `${ASSET_BASE}wasm/`,
  iccUrl: `${ASSET_BASE}iccs/`,
};

/** Resolves with the password typed by the user, or `null` if they cancel. */
export type PasswordPrompt = (incorrect: boolean) => Promise<string | null>;

export class PasswordCancelledError extends Error {
  constructor() {
    super("El usuario canceló la contraseña.");
    this.name = "PasswordCancelledError";
  }
}

export async function openPdf(
  bytes: Uint8Array,
  askPassword: PasswordPrompt,
): Promise<{ pdf: PDFDocumentProxy; password?: string }> {
  let password: string | undefined;
  let cancelled = false;

  // PDF.js transfers the buffer to its worker, so it gets its own copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice(), ...assetOptions });
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    void askPassword(incorrect).then((typed) => {
      if (typed === null) {
        cancelled = true;
        void task.destroy();
        return;
      }
      password = typed;
      update(typed);
    });
  };

  try {
    const pdf = await task.promise;
    return { pdf, password };
  } catch (error) {
    if (cancelled) throw new PasswordCancelledError();
    throw error;
  }
}

export function isRenderCancelled(error: unknown): boolean {
  return error instanceof pdfjsLib.RenderingCancelledException;
}

/**
 * Renders `page` into `canvas` at `scale` CSS pixels per PDF point, using the
 * device pixel ratio for sharpness. The returned task can be cancelled.
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  pixelRatio = window.devicePixelRatio || 1,
): RenderTask {
  const cssViewport = page.getViewport({ scale });
  const outputScale = clampOutputScale(cssViewport.width, cssViewport.height, pixelRatio);
  const viewport = page.getViewport({ scale: scale * outputScale });

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${cssViewport.width}px`;
  canvas.style.height = `${cssViewport.height}px`;

  return page.render({ canvas, viewport });
}

/** Browsers refuse canvases above ~16.7M pixels (less on iOS). */
const MAX_CANVAS_PIXELS = 16_777_216;

function clampOutputScale(width: number, height: number, desired: number): number {
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.max(0.25, Math.min(desired, maxScale));
}
