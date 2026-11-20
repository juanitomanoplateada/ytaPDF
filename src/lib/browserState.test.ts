import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DECORATIONS, decorationObjects, measureText, type PageDecorations } from "./decorations";
import { notifications } from "./notifications.svelte";
import { deleteSavedSignature, loadSavedSignatures, saveSignature } from "./signatures";
import { loadSignatureFont, SIGNATURE_FONTS, textToPath, type OutlineFont } from "./typedSignature";

/** An in-memory localStorage, optionally failing every call. */
function fakeStorage(failing = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (failing) throw new Error("Almacenamiento bloqueado");
  };
  return {
    data,
    getItem: (key: string) => (guard(), data.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void data.set(key, value)),
    removeItem: (key: string) => (guard(), void data.delete(key)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notifications", () => {
  it("keeps the four newest notices and dismisses each after its time", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    notifications.info("uno");
    notifications.success("dos");
    notifications.warning("tres");
    const withAction = notifications.error("cuatro", { label: "Deshacer", run });
    notifications.info("cinco");
    expect(notifications.items.map((n) => n.message)).toEqual(["dos", "tres", "cuatro", "cinco"]);
    vi.advanceTimersByTime(4000);
    expect(notifications.items.map((n) => n.message)).toEqual(["tres", "cuatro"]);
    vi.advanceTimersByTime(5000);
    expect(notifications.items.map((n) => n.id)).toEqual([withAction]);
    vi.advanceTimersByTime(2000);
    expect(notifications.items).toEqual([]);
  });
});

describe("theme", () => {
  beforeEach(() => vi.resetModules());

  it("follows the system outside the browser and when nothing is saved", async () => {
    const { theme } = await import("./theme.svelte");
    expect(theme.choice).toBe("system");
    vi.stubGlobal("localStorage", fakeStorage(true));
    // Without a document there is nothing to apply it to.
    expect(() => theme.set("dark")).not.toThrow();
  });

  it("reads the saved choice and applies changes to the page", async () => {
    const storage = fakeStorage();
    storage.data.set("ytapdf.theme", "dark");
    const dataset: Record<string, string> = {};
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement: { dataset } });
    const { theme } = await import("./theme.svelte");
    expect(theme.choice).toBe("dark");
    theme.set("light");
    expect(dataset.theme).toBe("light");
    expect(storage.data.get("ytapdf.theme")).toBe("light");
    theme.set("system");
    expect(dataset.theme).toBeUndefined();
    expect(storage.data.has("ytapdf.theme")).toBe(false);
  });

  it("ignores saved values it does not know and storage it cannot read", async () => {
    vi.stubGlobal("window", {});
    const storage = fakeStorage();
    storage.data.set("ytapdf.theme", "azul");
    vi.stubGlobal("localStorage", storage);
    expect((await import("./theme.svelte")).theme.choice).toBe("system");
    vi.resetModules();
    vi.stubGlobal("localStorage", fakeStorage(true));
    expect((await import("./theme.svelte")).theme.choice).toBe("system");
  });
});

describe("saved signatures", () => {
  it("keeps five of each kind, newest first, and forgets deleted ones", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    let list = saveSignature({ initials: true, path: "M 0 0", width: 1, height: 1 } as never);
    for (let i = 0; i < 6; i++) {
      vi.spyOn(Date, "now").mockReturnValue(1000 + i);
      list = saveSignature({ path: `M ${i} 0`, width: 1, height: 1 } as never);
    }
    expect(list.filter((s) => !s.initials)).toHaveLength(5);
    expect(list.filter((s) => s.initials)).toHaveLength(1);
    expect(loadSavedSignatures()).toEqual(list);
    for (const signature of list) list = deleteSavedSignature(signature.id);
    expect(list).toEqual([]);
    expect(storage.data.has("ytapdf.signatures")).toBe(false);
  });

  it("drops entries that are neither drawings nor images", () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    storage.data.set("ytapdf.signatures", JSON.stringify([{ id: "a", image: "data:" }, { id: "b" }]));
    expect(loadSavedSignatures().map((s) => s.id)).toEqual(["a"]);
    storage.data.set("ytapdf.signatures", JSON.stringify({ id: "a" }));
    expect(loadSavedSignatures()).toEqual([]);
  });

  it("works without storage, remembering nothing", () => {
    vi.stubGlobal("localStorage", fakeStorage(true));
    expect(loadSavedSignatures()).toEqual([]);
    expect(saveSignature({ path: "M 0 0", width: 1, height: 1 } as never)).toHaveLength(1);
  });
});

describe("typed signatures", () => {
  it("uses each glyph's advance when the layout has no positions and draws unknown commands as lines", () => {
    const font = {
      unitsPerEm: 100,
      layout: () => ({
        glyphs: [{ advanceWidth: 50, path: { commands: [{ command: "moveTo", args: [0, 0] }, { command: "arcTo", args: [10, 10] }] } }],
      }),
    } as unknown as OutlineFont;
    expect(textToPath(font, "a", 100, 0)).toEqual({ path: "M 0 10 L 10 0", width: 10, height: 10 });
  });

  it("downloads each font once, retrying after a failure", async () => {
    const fetch = vi.fn(async () => ({ ok: false }) as Response);
    vi.stubGlobal("fetch", fetch);
    await expect(loadSignatureFont("vibes")).rejects.toThrow("No se pudo cargar la fuente Great Vibes.");
    const bytes = new Uint8Array([0, 1, 0, 0]);
    fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer } as Response);
    const fontkit = await import("@cantoo/fontkit");
    const create = vi.spyOn(fontkit.default, "create").mockReturnValue({ unitsPerEm: 1000 } as never);
    const font = await loadSignatureFont("vibes");
    expect(font).toEqual({ unitsPerEm: 1000 });
    expect(await loadSignatureFont("vibes")).toBe(font);
    expect(create).toHaveBeenCalledTimes(1);
    // Unknown fonts fall back to the first one.
    await loadSignatureFont("otra" as never);
    expect(fetch).toHaveBeenLastCalledWith(SIGNATURE_FONTS[0].url);
  });
});

describe("decorations", () => {
  const context = { index: 0, total: 3, width: 600, height: 800, name: "Informe", date: "1/1/2026" };
  const with_ = (changes: Partial<PageDecorations>): PageDecorations => ({ ...DEFAULT_DECORATIONS, ...changes });

  it("estimates the watermark size without a measure and lays it flat when not diagonal", () => {
    const [mark] = decorationObjects(
      with_({ watermark: { ...DEFAULT_DECORATIONS.watermark, text: "BORRADOR", diagonal: false }, numbers: { ...DEFAULT_DECORATIONS.numbers, enabled: false } }),
      context,
    );
    expect(mark).toMatchObject({ angle: 0, fontWeight: "bold" });
    expect(mark.fontSize).toBeCloseTo((480 / (8 * 100 * 0.62)) * 100, 0);
  });

  it("places headers, footers and numbers at each alignment", () => {
    const objects = decorationObjects(
      with_({
        header: { text: "{nombre}", align: "right" },
        footer: { text: "{fecha}", align: "center" },
        numbers: { enabled: true, position: "top-left", format: "{n}", startAt: 1 },
      }),
      context,
    );
    expect(objects.map((o) => [o.text, o.left, o.top])).toEqual([
      ["Informe", 572, 28],
      ["1/1/2026", 300, 772],
      ["1", 28, 28],
    ]);
    const right = decorationObjects(with_({ numbers: { ...DEFAULT_DECORATIONS.numbers, position: "bottom-right" } }), context);
    expect(right[0]).toMatchObject({ left: 572, top: 772, originX: "right" });
    const centred = decorationObjects(DEFAULT_DECORATIONS, context);
    expect(centred[0]).toMatchObject({ text: "1 / 3", left: 300, originX: "center", originY: "bottom" });
  });

  it("measures with a canvas when there is a document, and estimates otherwise", () => {
    expect(measureText("abc", 10, false)).toBeCloseTo(16.5);
    const measure = vi.fn(() => ({ width: 42 }));
    const canvasContext = { font: "", measureText: measure };
    const createElement = vi.fn(() => ({ getContext: () => canvasContext }));
    vi.stubGlobal("document", { createElement });
    expect(measureText("abc", 10, true)).toBe(42);
    expect(canvasContext.font).toBe('bold 10px Helvetica, Arial, "Liberation Sans", sans-serif');
    expect(measureText("abc", 12, false)).toBe(42);
    expect(createElement).toHaveBeenCalledTimes(1);
  });
});

describe("measuring without a canvas", () => {
  it("falls back to the estimate when the canvas has no 2D context", async () => {
    vi.resetModules();
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    const { measureText: measure } = await import("./decorations");
    expect(measure("abc", 10, true)).toBeCloseTo(18.6);
  });
});
