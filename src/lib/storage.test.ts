import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

/** An in-memory localStorage, optionally failing every call. */
function fakeStorage(failing = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (failing) throw new Error("bloqueado");
  };
  return {
    data,
    getItem: (key: string) => (guard(), data.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void data.set(key, value)),
    removeItem: (key: string) => (guard(), void data.delete(key)),
  };
}

/**
 * Just enough IndexedDB for the session store: one object store, requests
 * that succeed on the next tick, and switches to make opening or a
 * transaction fail.
 */
function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const failures = { open: undefined as DOMException | null | undefined, transaction: undefined as "error" | "abort" | undefined };
  const later = (run: () => void) => setTimeout(run, 0);
  const factory = {
    data,
    failures,
    upgraded: 0,
    open() {
      const request: Record<string, unknown> & { result?: unknown; error?: DOMException | null } = {};
      later(() => {
        if (failures.open !== undefined) {
          request.error = failures.open;
          (request.onerror as () => void)();
          return;
        }
        const db = {
          createObjectStore: () => factory.upgraded++,
          close: () => {},
          transaction() {
            const transaction: Record<string, unknown> & { error: DOMException | null } = { error: null };
            const store = {
              get: (key: string) => ({ result: structuredClone(data.get(key)) }),
              put: (value: unknown, key: string) => (data.set(key, structuredClone(value)), { result: key }),
              delete: (key: string) => (data.delete(key), { result: undefined }),
            };
            transaction.objectStore = () => store;
            later(() => {
              if (failures.transaction === "error") (transaction.onerror as () => void)();
              else if (failures.transaction === "abort") (transaction.onabort as () => void)();
              else (transaction.oncomplete as () => void)();
            });
            return transaction;
          },
        };
        request.result = db;
        (request.onupgradeneeded as () => void)();
        (request.onsuccess as () => void)();
      });
      return request;
    },
  };
  return factory;
}

describe("saved works", () => {
  let db: ReturnType<typeof fakeIndexedDb>;
  beforeEach(() => {
    db = fakeIndexedDb();
    vi.stubGlobal("indexedDB", db);
  });

  const session = (id: string, savedAt: number, kept = false) =>
    ({ version: 1, id, savedAt, documentName: `Doc ${id}`, kept, sources: [], pages: [{}, {}], annotations: {}, formValues: {}, images: [] }) as never;

  it("saves, lists newest first, loads and deletes works", async () => {
    const store = await import("./session");
    await store.saveSession(session("a", 1));
    await store.saveSession(session("b", 2, true));
    await store.saveSession(session("a", 3));
    expect(await store.listSessions()).toEqual([
      { id: "a", documentName: "Doc a", savedAt: 3, pageCount: 2, kept: false },
      { id: "b", documentName: "Doc b", savedAt: 2, pageCount: 2, kept: true },
    ]);
    expect((await store.loadSession("b"))?.documentName).toBe("Doc b");
    expect(await store.loadSession("nada")).toBeNull();
    await store.clearRecoveryCopies();
    expect((await store.listSessions()).map((s) => s.id)).toEqual(["b"]);
    expect(db.upgraded).toBeGreaterThan(0);
  });

  it("lists the recovery copy kept before works had an index", async () => {
    const store = await import("./session");
    db.data.set("current", { version: 1, savedAt: 5, documentName: "Antiguo", pages: [] });
    expect(await store.listSessions()).toEqual([{ id: "current", documentName: "Antiguo", savedAt: 5, pageCount: 0, kept: false }]);
    db.data.set("current", { version: 2 });
    expect(await store.listSessions()).toEqual([]);
    db.data.set("old", { version: 0 });
    expect(await store.loadSession("old")).toBeNull();
  });

  it("copes with storage that cannot be opened or written", async () => {
    const store = await import("./session");
    db.failures.open = null;
    expect(await store.listSessions()).toEqual([]);
    await expect(store.saveSession(session("a", 1))).rejects.toThrow("No se pudo acceder al almacenamiento local.");
    db.failures.open = new DOMException("Cuota", "QuotaExceededError");
    await expect(store.saveSession(session("a", 1))).rejects.toThrow("Cuota");
    db.failures.open = undefined;
    db.failures.transaction = "error";
    expect(await store.loadSession("a")).toBeNull();
    db.failures.transaction = "abort";
    await expect(store.deleteSession("a")).resolves.toBeUndefined();
  });
});

describe("recovery preference", () => {
  it("is off by default, remembers being turned on and survives blocked storage", async () => {
    const { recoveryEnabled, setRecoveryEnabled } = await import("./session");
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    expect(recoveryEnabled()).toBe(false);
    setRecoveryEnabled(true);
    expect(recoveryEnabled()).toBe(true);
    setRecoveryEnabled(false);
    expect(storage.data.size).toBe(0);
    vi.stubGlobal("localStorage", fakeStorage(true));
    expect(recoveryEnabled()).toBe(false);
    expect(() => setRecoveryEnabled(true)).not.toThrow();
  });
});

describe("interface language", () => {
  beforeEach(() => vi.resetModules());

  const load = async () => import("./i18n.svelte");

  it("is Spanish outside the browser and translates to English with placeholders", async () => {
    const { i18n, t, pagesLabel, interpolate } = await load();
    expect(i18n.locale).toBe("es");
    expect(i18n.tag).toBe("es");
    expect(pagesLabel(1)).toBe("1 página");
    vi.stubGlobal("localStorage", fakeStorage(true));
    i18n.set("en");
    expect(i18n.tag).toBe("en-GB");
    expect(pagesLabel(1)).toBe("1 page");
    expect(pagesLabel(3)).toBe("3 pages");
    expect(t("Texto sin traducción {x}", { x: 1 })).toBe("Texto sin traducción 1");
    expect(interpolate("{a} y {b}", { a: "uno" })).toBe("uno y {b}");
    expect(interpolate("{a}")).toBe("{a}");
  });

  it("starts in the saved language and marks the page with it", async () => {
    const storage = fakeStorage();
    storage.data.set("ytapdf.locale", "en");
    const documentElement = { lang: "" };
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement });
    const { i18n } = await load();
    expect(i18n.locale).toBe("en");
    i18n.set("es");
    expect(documentElement.lang).toBe("es");
    expect(storage.data.get("ytapdf.locale")).toBe("es");
  });

  it("otherwise follows the browser's languages", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", fakeStorage(true));
    vi.stubGlobal("navigator", { languages: ["fr-FR", "es-MX"] });
    expect((await load()).i18n.locale).toBe("es");
    vi.resetModules();
    vi.stubGlobal("navigator", { language: "de-DE" });
    expect((await load()).i18n.locale).toBe("en");
    vi.resetModules();
    vi.stubGlobal("navigator", { languages: [undefined] });
    expect((await load()).i18n.locale).toBe("en");
    vi.resetModules();
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("localStorage", fakeStorage());
    expect((await load()).i18n.locale).toBe("es");
  });

  it("formats dates and sizes in the interface language", async () => {
    const { formatBytes, formatDate } = await load();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5120 GB");
    expect(formatDate(new Date(2026, 0, 2), { year: "numeric" })).toBe("2026");
  });
});
