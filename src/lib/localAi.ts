/**
 * Optional on-device AI with the APIs built into Chrome (Summarizer,
 * Translator, Language Detector; stable since Chrome 138 on desktop). The
 * models run on the device, so the document's text does not leave it. Other
 * browsers, mobile Chrome and devices without the hardware Chrome requires
 * simply do not offer them, and the feature says so.
 */

export type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface DownloadMonitor {
  addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

interface CreateOptions {
  monitor?: (monitor: DownloadMonitor) => void;
  signal?: AbortSignal;
}

interface SummarizerOptions {
  type?: "key-points" | "tldr" | "teaser" | "headline";
  format?: "markdown" | "plain-text";
  length?: "short" | "medium" | "long";
  sharedContext?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
}

interface SummarizerInstance {
  summarize(text: string, options?: { context?: string; signal?: AbortSignal }): Promise<string>;
  measureInputUsage?(text: string): Promise<number>;
  inputQuota?: number;
  destroy(): void;
}

interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface DetectorInstance {
  detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy(): void;
}

interface SummarizerApi {
  availability(options?: SummarizerOptions): Promise<Availability>;
  create(options?: SummarizerOptions & CreateOptions): Promise<SummarizerInstance>;
}

interface TranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: { sourceLanguage: string; targetLanguage: string } & CreateOptions): Promise<TranslatorInstance>;
}

interface DetectorApi {
  availability(): Promise<Availability>;
  create(options?: CreateOptions): Promise<DetectorInstance>;
}

const apis = () => globalThis as unknown as { Summarizer?: SummarizerApi; Translator?: TranslatorApi; LanguageDetector?: DetectorApi };

/** Which of the APIs this browser has at all (they may still need a download). */
export function aiSupport(): { summarize: boolean; translate: boolean; detect: boolean } {
  const { Summarizer, Translator, LanguageDetector } = apis();
  return { summarize: !!Summarizer, translate: !!Translator, detect: !!LanguageDetector };
}

/** Languages offered as targets of a translation (Chrome supports these and more). */
export const TRANSLATION_LANGUAGES = ["es", "en", "fr", "de", "it", "pt", "nl", "pl", "ca", "ja", "zh", "ko", "ar", "ru", "uk", "tr", "hi"];

/** Languages the Summarizer can write in. */
export const SUMMARY_LANGUAGES = ["es", "en", "fr", "de", "ja"];

/** How long to wait for Chrome to say whether a model can run before treating it as unavailable. */
const AVAILABILITY_TIMEOUT_MS = 8000;

/** Some builds expose the APIs without the service behind them: their promises never settle. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** Rejects as soon as `signal` aborts, whatever `promise` does. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Detenido", "AbortError"));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new DOMException("Detenido", "AbortError")), { once: true }),
    ),
  ]);
}

export type ProgressHandler = (event: { phase: "download" | "work"; progress: number }) => void;

const monitorWith = (onProgress?: ProgressHandler) => (monitor: DownloadMonitor) => {
  monitor.addEventListener("downloadprogress", (event) => onProgress?.({ phase: "download", progress: event.loaded }));
};

/**
 * Splits text into pieces of at most `max` characters, at paragraph breaks
 * where possible, then at sentence ends, then at spaces.
 */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  const add = (piece: string, separator: string) => {
    if (!piece.trim()) return;
    if (current && current.length + separator.length + piece.length > max) flush();
    if (piece.length <= max) {
      current = current ? `${current}${separator}${piece}` : piece;
      return;
    }
    // A paragraph too long for one piece: by sentences, then by words.
    const parts = piece.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [piece];
    for (const part of parts) {
      if (part.length <= max) {
        if (current && current.length + part.length > max) flush();
        current += part;
      } else {
        for (const word of part.split(/(\s+)/)) {
          if (current.length + word.length > max) flush();
          current += word.length > max ? word.slice(0, max) : word;
        }
      }
    }
  };
  for (const paragraph of text.split(/\n\s*\n|\n(?=\s*[-•*\d])/)) add(paragraph.replace(/\s*\n\s*/g, " "), "\n\n");
  flush();
  return chunks;
}

/** Characters per piece sent to the Summarizer: well within its input quota. */
const SUMMARY_CHUNK = 3500;
const TRANSLATION_CHUNK = 1500;

export interface SummaryOptions {
  type: "key-points" | "tldr";
  length: "short" | "medium" | "long";
  outputLanguage: string;
}

export async function summarizerAvailability(options: SummaryOptions): Promise<Availability> {
  const { Summarizer } = apis();
  if (!Summarizer) return "unavailable";
  try {
    return await withTimeout(Summarizer.availability({ ...options, format: "markdown" }), AVAILABILITY_TIMEOUT_MS, "unavailable");
  } catch {
    return "unavailable";
  }
}

/**
 * Summarises a long text: each piece is summarised, and the summaries are
 * then summarised together when there are several.
 */
export async function summarize(
  text: string,
  options: SummaryOptions,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  const { Summarizer } = apis();
  if (!Summarizer) throw new Error("unavailable");
  const summarizer = await Summarizer.create({
    ...options,
    format: "markdown",
    sharedContext: "Un documento PDF abierto en un editor.",
    outputLanguage: options.outputLanguage,
    monitor: monitorWith(onProgress),
    signal,
  });
  try {
    const pieces = chunkText(text, SUMMARY_CHUNK);
    if (pieces.length === 0) return "";
    if (pieces.length === 1) {
      onProgress?.({ phase: "work", progress: 0.5 });
      return await summarizer.summarize(pieces[0], { signal });
    }
    const partials: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      onProgress?.({ phase: "work", progress: i / (pieces.length + 1) });
      partials.push(await summarizer.summarize(pieces[i], { signal, context: `Parte ${i + 1} de ${pieces.length} del documento.` }));
    }
    onProgress?.({ phase: "work", progress: pieces.length / (pieces.length + 1) });
    const joined = partials.join("\n\n");
    // Summaries that still do not fit together are returned one after another.
    if (joined.length > SUMMARY_CHUNK * 2) return joined;
    return await summarizer.summarize(joined, { signal, context: "Resúmenes de las partes de un documento." });
  } finally {
    summarizer.destroy();
  }
}

/** The language a text is written in (BCP 47 code), or null when unsure. */
export async function detectLanguage(text: string, onProgress?: ProgressHandler): Promise<string | null> {
  const { LanguageDetector } = apis();
  if (!LanguageDetector) return null;
  const detector = await LanguageDetector.create({ monitor: monitorWith(onProgress) });
  try {
    const [best] = await detector.detect(text.slice(0, 4000));
    return best && best.confidence >= 0.5 && best.detectedLanguage !== "und" ? best.detectedLanguage : null;
  } finally {
    detector.destroy();
  }
}

export async function translatorAvailability(sourceLanguage: string, targetLanguage: string): Promise<Availability> {
  const { Translator } = apis();
  if (!Translator) return "unavailable";
  try {
    return await withTimeout(Translator.availability({ sourceLanguage, targetLanguage }), AVAILABILITY_TIMEOUT_MS, "unavailable");
  } catch {
    return "unavailable";
  }
}

/** Translates a long text piece by piece, keeping its paragraphs. */
export async function translate(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  const { Translator } = apis();
  if (!Translator) throw new Error("unavailable");
  const translator = await Translator.create({ sourceLanguage, targetLanguage, monitor: monitorWith(onProgress), signal });
  try {
    const pieces = chunkText(text, TRANSLATION_CHUNK);
    const out: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      onProgress?.({ phase: "work", progress: i / pieces.length });
      out.push(await translator.translate(pieces[i], { signal }));
    }
    return out.join("\n\n");
  } finally {
    translator.destroy();
  }
}
