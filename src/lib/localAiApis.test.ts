import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortable,
  aiSupport,
  chunkText,
  detectLanguage,
  summarize,
  summarizerAvailability,
  translate,
  translatorAvailability,
} from "./localAi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A create() that reports download progress through the monitor it is given. */
const creating =
  <T>(instance: T) =>
  async (options: { monitor?: (monitor: { addEventListener(type: string, listener: (event: { loaded: number }) => void): void }) => void }) => {
    options.monitor?.({ addEventListener: (_type, listener) => listener({ loaded: 0.4 }) });
    return instance;
  };

describe("support", () => {
  it("says which APIs the browser has", () => {
    expect(aiSupport()).toEqual({ summarize: false, translate: false, detect: false });
    vi.stubGlobal("Summarizer", {});
    vi.stubGlobal("Translator", {});
    vi.stubGlobal("LanguageDetector", {});
    expect(aiSupport()).toEqual({ summarize: true, translate: true, detect: true });
  });

  it("reports availability, treating errors and silence as unavailable", async () => {
    const options = { type: "tldr", length: "short", outputLanguage: "es" } as const;
    expect(await summarizerAvailability(options)).toBe("unavailable");
    expect(await translatorAvailability("es", "en")).toBe("unavailable");
    vi.stubGlobal("Summarizer", { availability: async () => "available" });
    vi.stubGlobal("Translator", { availability: async () => Promise.reject(new Error("no")) });
    expect(await summarizerAvailability(options)).toBe("available");
    expect(await translatorAvailability("es", "en")).toBe("unavailable");

    vi.useFakeTimers();
    vi.stubGlobal("Summarizer", { availability: async () => Promise.reject(new Error("no")) });
    vi.stubGlobal("Translator", { availability: () => new Promise(() => {}) });
    expect(await summarizerAvailability(options)).toBe("unavailable");
    const pending = translatorAvailability("es", "en");
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBe("unavailable");
  });
});

describe("stopping", () => {
  it("rejects when the signal aborts, before or after starting", async () => {
    const never = new Promise<string>(() => {});
    expect(await abortable(Promise.resolve(1))).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(abortable(never, aborted.signal)).rejects.toThrow("Detenido");
    const later = new AbortController();
    const running = abortable(never, later.signal);
    later.abort();
    await expect(running).rejects.toThrow("Detenido");
    expect(await abortable(Promise.resolve(2), new AbortController().signal)).toBe(2);
  });
});

describe("summaries", () => {
  const options = { type: "key-points", length: "medium", outputLanguage: "es" } as const;

  it("needs the API", async () => {
    await expect(summarize("texto", options)).rejects.toThrow("unavailable");
  });

  it("summarises nothing, one piece, or the summaries of several pieces", async () => {
    const destroy = vi.fn();
    const summarizeFn = vi.fn(async (text: string) => `resumen de ${text.length}`);
    vi.stubGlobal("Summarizer", { create: creating({ summarize: summarizeFn, destroy }) });
    const progress = vi.fn();
    expect(await summarize("   ", options, progress)).toBe("");
    expect(await summarize("Hola.", options, progress)).toBe("resumen de 5");
    expect(progress).toHaveBeenCalledWith({ phase: "download", progress: 0.4 });
    expect(progress).toHaveBeenCalledWith({ phase: "work", progress: 0.5 });

    const long = Array.from({ length: 3 }, () => "a".repeat(3000)).join("\n\n");
    expect(await summarize(long, options)).toBe("resumen de 49");
    expect(summarizeFn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ context: "Resúmenes de las partes de un documento." }));
    expect(destroy).toHaveBeenCalledTimes(3);
  });

  it("returns the partial summaries when they are too long to join", async () => {
    vi.stubGlobal("Summarizer", { create: creating({ summarize: async () => "x".repeat(4000), destroy: () => {} }) });
    const long = Array.from({ length: 2 }, () => "a".repeat(3000)).join("\n\n");
    expect(await summarize(long, options)).toBe(`${"x".repeat(4000)}\n\n${"x".repeat(4000)}`);
  });
});

describe("languages and translations", () => {
  it("detects confident languages only", async () => {
    expect(await detectLanguage("hola")).toBeNull();
    const results = [[{ detectedLanguage: "es", confidence: 0.9 }], [{ detectedLanguage: "und", confidence: 0.9 }], [{ detectedLanguage: "fr", confidence: 0.2 }], []];
    const destroy = vi.fn();
    vi.stubGlobal("LanguageDetector", { create: creating({ detect: async () => results.shift(), destroy }) });
    expect(await detectLanguage("hola")).toBe("es");
    expect(await detectLanguage("hola")).toBeNull();
    expect(await detectLanguage("hola")).toBeNull();
    expect(await detectLanguage("hola", vi.fn())).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(4);
  });

  it("translates piece by piece", async () => {
    await expect(translate("hola", "es", "en")).rejects.toThrow("unavailable");
    const destroy = vi.fn();
    vi.stubGlobal("Translator", { create: creating({ translate: async (text: string) => text.toUpperCase(), destroy }) });
    const progress = vi.fn();
    expect(await translate("uno\n\ndos", "es", "en", progress)).toBe("UNO\n\nDOS");
    expect(progress).toHaveBeenCalledWith({ phase: "work", progress: 0 });
    expect(destroy).toHaveBeenCalled();
  });
});

describe("splitting text", () => {
  it("cuts long paragraphs by sentences, then by words, and long words to size", () => {
    expect(chunkText("Uno dos. Tres cuatro cinco.", 12)).toEqual(["Uno dos.", "Tres cuatro", "cinco."]);
    expect(chunkText("abcdefghijklmnop", 5)).toEqual(["abcde"]);
    expect(chunkText("?????????", 4)).toEqual(["????"]);
    expect(chunkText("uno\n\ndos\n\ntres", 9)).toEqual(["uno\n\ndos", "tres"]);
    expect(chunkText("- uno\n- dos", 100)).toEqual(["- uno\n\n- dos"]);
    expect(chunkText("uno\n  dos", 100)).toEqual(["uno dos"]);
  });
});
