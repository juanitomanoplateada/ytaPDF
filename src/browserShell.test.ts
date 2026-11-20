import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── Service worker ───────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>) => void;

class FakeResponse {
  static redirect = vi.fn((url: string, status: number) => ({ redirect: url, status }));
  static error = vi.fn(() => ({ error: true }));
  constructor(
    readonly body: unknown,
    readonly init?: { headers: Record<string, string> },
  ) {}
}

async function loadServiceWorker() {
  const handlers = new Map<string, Handler>();
  const cache = { addAll: vi.fn(), put: vi.fn(), match: vi.fn() };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["ytapdf-shell-viejo", "otra-app", "ytapdf-shell-__VERSION__", "ytapdf-runtime-__VERSION__"]),
    delete: vi.fn(),
    match: vi.fn(),
  };
  const skipWaiting = vi.fn();
  const claim = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal("__PRECACHE__", ["/", "/index.html"]);
  vi.stubGlobal("addEventListener", (type: string, handler: Handler) => handlers.set(type, handler));
  vi.stubGlobal("caches", caches);
  vi.stubGlobal("clients", { claim });
  vi.stubGlobal("location", { origin: "https://ytapdf.test" });
  vi.stubGlobal("skipWaiting", skipWaiting);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("Response", FakeResponse);
  // Relative URLs resolve against the worker's location in a browser.
  vi.stubGlobal("Request", class {
    constructor(readonly url: string) {}
  });
  await import("./sw.js");
  /** Fires an event and waits for what it was told to wait for or respond with. */
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    let pending: unknown;
    handlers.get(type)!({ ...event, waitUntil: (p: unknown) => (pending = p), respondWith: (p: unknown) => (pending = p) });
    return pending === undefined ? undefined : await pending;
  };
  return { fire, cache, caches, skipWaiting, claim, fetch };
}

const get = (url: string, mode = "cors") => ({ request: { method: "GET", url, mode } });

describe("service worker", () => {
  it("precaches the shell and clears old caches of this app on activation", async () => {
    const sw = await loadServiceWorker();
    await sw.fire("install");
    expect(sw.cache.addAll).toHaveBeenCalledWith(["/", "/index.html"]);
    await sw.fire("activate");
    expect(sw.caches.delete.mock.calls).toEqual([["ytapdf-shell-viejo"]]);
    expect(sw.claim).toHaveBeenCalled();
  });

  it("updates only when a page of this app asks", async () => {
    const sw = await loadServiceWorker();
    await sw.fire("message", { origin: "https://otro.test", data: { type: "SKIP_WAITING" } });
    await sw.fire("message", { origin: "https://ytapdf.test" });
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    await sw.fire("message", { origin: "https://ytapdf.test", data: { type: "SKIP_WAITING" } });
    expect(sw.skipWaiting).toHaveBeenCalled();
  });

  it("keeps files shared with the app and opens it, even when nothing usable arrives", async () => {
    const sw = await loadServiceWorker();
    const files = [new File(["a"], "uno.pdf", { type: "application/pdf" }), "texto", new File(["b"], "dos raro")];
    const share = (formData: () => Promise<unknown>) => ({ request: { method: "POST", url: "https://ytapdf.test/compartir", formData } });
    expect(await sw.fire("fetch", share(async () => ({ getAll: () => files })))).toEqual({ redirect: "/?compartido=1", status: 303 });
    expect(sw.cache.put).toHaveBeenCalledTimes(2);
    const [, second] = sw.cache.put.mock.calls[1];
    expect(second.init.headers).toEqual({ "Content-Type": "application/octet-stream", "X-Nombre": "dos%20raro" });
    expect(await sw.fire("fetch", share(async () => Promise.reject(new Error("vacío"))))).toEqual({ redirect: "/?compartido=1", status: 303 });
  });

  it("leaves other posts and other sites to the network", async () => {
    const sw = await loadServiceWorker();
    expect(await sw.fire("fetch", { request: { method: "POST", url: "https://ytapdf.test/otra" } })).toBeUndefined();
    expect(await sw.fire("fetch", { request: { method: "POST", url: "https://otro.test/compartir" } })).toBeUndefined();
    expect(await sw.fire("fetch", get("https://otro.test/app.js"))).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("serves pages from the network, falling back to the cached shell", async () => {
    const sw = await loadServiceWorker();
    sw.fetch.mockResolvedValueOnce("página");
    expect(await sw.fire("fetch", get("https://ytapdf.test/", "navigate"))).toBe("página");
    sw.fetch.mockRejectedValue(new Error("sin conexión"));
    sw.caches.match.mockResolvedValueOnce("shell");
    expect(await sw.fire("fetch", get("https://ytapdf.test/", "navigate"))).toBe("shell");
    sw.caches.match.mockResolvedValueOnce(undefined);
    expect(await sw.fire("fetch", get("https://ytapdf.test/", "navigate"))).toEqual({ error: true });
  });

  it("serves assets from the cache, keeping app assets it downloads", async () => {
    const sw = await loadServiceWorker();
    sw.caches.match.mockResolvedValueOnce("guardado");
    expect(await sw.fire("fetch", get("https://ytapdf.test/assets/a.js"))).toBe("guardado");
    const fresh = (ok: boolean) => ({ ok, clone: () => "copia" });
    for (const [path, ok] of [["/assets/b.js", true], ["/pdfjs/c.wasm", true], ["/tesseract/d.js", true], ["/otro.png", true], ["/assets/e.js", false]] as const) {
      sw.fetch.mockResolvedValueOnce(fresh(ok));
      await sw.fire("fetch", get(`https://ytapdf.test${path}`));
    }
    expect(sw.cache.put).toHaveBeenCalledTimes(3);
  });
});

// ── Saving, sharing and printing ─────────────────────────────────────────

function stubDom() {
  const appended: Record<string, unknown>[] = [];
  const element = (tag: string) => {
    const listeners = new Map<string, () => void>();
    const node: Record<string, unknown> = {
      tag,
      style: {},
      click: vi.fn(),
      remove: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      fire: (type: string) => listeners.get(type)?.(),
      contentWindow: { focus: vi.fn(), print: vi.fn() },
    };
    return node;
  };
  vi.stubGlobal("document", {
    createElement: vi.fn(element),
    body: { appendChild: (node: Record<string, unknown>) => appended.push(node) },
  });
  const createObjectURL = vi.fn(() => "blob:url");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  return { appended, createObjectURL, revokeObjectURL };
}

describe("delivering files", () => {
  beforeEach(() => vi.resetModules());

  it("downloads through a temporary link, revoking it later", async () => {
    vi.useFakeTimers();
    const dom = stubDom();
    const { downloadBytes } = await import("./lib/deliver");
    downloadBytes(new Uint8Array([1]), "a.pdf", "application/pdf");
    const [link] = dom.appended;
    expect(link).toMatchObject({ href: "blob:url", download: "a.pdf" });
    expect(link.click).toHaveBeenCalled();
    expect(dom.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(dom.revokeObjectURL).toHaveBeenCalledWith("blob:url");
  });

  it("picks where to save when the browser can, and treats cancelling as no choice", async () => {
    const plain = await import("./lib/deliver");
    expect(plain.canPickSaveLocation).toBe(false);
    expect(await plain.pickSaveLocation("a.pdf", "application/pdf")).toBeNull();

    vi.resetModules();
    const handle = { name: "a.pdf" };
    const picker = vi.fn(async () => handle);
    vi.stubGlobal("showSaveFilePicker", picker);
    const deliver = await import("./lib/deliver");
    expect(deliver.canPickSaveLocation).toBe(true);
    expect(await deliver.pickSaveLocation("a.pdf", "application/pdf")).toBe(handle);
    await deliver.pickSaveLocation("x.bin", "application/octet-stream");
    expect(picker).toHaveBeenLastCalledWith({ suggestedName: "x.bin", types: [{ description: "Archivo", accept: { "application/octet-stream": [""] } }] });
    picker.mockRejectedValueOnce(new DOMException("cancelado", "AbortError"));
    expect(await deliver.pickSaveLocation("a.pdf", "application/pdf")).toBeNull();
    picker.mockRejectedValueOnce(new Error("disco lleno"));
    await expect(deliver.pickSaveLocation("a.pdf", "application/pdf")).rejects.toThrow("disco lleno");
  });

  it("asks for permission to write only when needed", async () => {
    const { ensureWritable, writeToHandle } = await import("./lib/deliver");
    const handle = (query?: string, request?: string | Error) => ({
      name: "a.pdf",
      createWritable: vi.fn(),
      queryPermission: query === undefined ? undefined : vi.fn(async () => query),
      requestPermission: request === undefined ? undefined : vi.fn(async () => (request instanceof Error ? Promise.reject(request) : request)),
    });
    expect(await ensureWritable(handle("granted") as never)).toBe(true);
    expect(await ensureWritable(handle("prompt", "granted") as never)).toBe(true);
    expect(await ensureWritable(handle("prompt", "denied") as never)).toBe(false);
    expect(await ensureWritable(handle() as never)).toBe(true);
    expect(await ensureWritable(handle("prompt", new Error("no")) as never)).toBe(false);

    const writable = { write: vi.fn(), close: vi.fn() };
    await writeToHandle({ name: "a.pdf", createWritable: async () => writable }, new Uint8Array([1]));
    expect(writable.close).toHaveBeenCalled();
  });

  it("knows whether files can be shared", async () => {
    vi.stubGlobal("navigator", undefined);
    expect((await import("./lib/deliver")).canShareFiles).toBe(false);
    vi.resetModules();
    vi.stubGlobal("navigator", { canShare: () => true });
    expect((await import("./lib/deliver")).canShareFiles).toBe(true);
    vi.resetModules();
    vi.stubGlobal("navigator", {
      canShare: () => {
        throw new Error("no");
      },
    });
    expect((await import("./lib/deliver")).canShareFiles).toBe(false);
    vi.resetModules();
    vi.stubGlobal("navigator", {});
    expect((await import("./lib/deliver")).canShareFiles).toBe(false);
  });

  it("shares files, treating cancelling as not shared", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    const { shareFile } = await import("./lib/deliver");
    expect(await shareFile(new Uint8Array([1]), "a.pdf", "application/pdf")).toBe(true);
    share.mockRejectedValueOnce(new DOMException("cancelado", "AbortError"));
    expect(await shareFile(new Uint8Array([1]), "a.pdf", "application/pdf")).toBe(false);
    share.mockRejectedValueOnce(new Error("roto"));
    await expect(shareFile(new Uint8Array([1]), "a.pdf", "application/pdf")).rejects.toThrow("roto");
  });

  it("prints through a hidden frame, opening a tab when the frame cannot print", async () => {
    vi.useFakeTimers();
    const dom = stubDom();
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const { printPdf, releasePrintFrame } = await import("./lib/deliver");
    releasePrintFrame();
    const printing = printPdf(new Uint8Array([1]));
    const frame = dom.appended[0] as { fire(type: string): void; contentWindow: { print: ReturnType<typeof vi.fn> } };
    frame.fire("load");
    await vi.advanceTimersByTimeAsync(250);
    await printing;
    expect(frame.contentWindow.print).toHaveBeenCalled();

    const again = printPdf(new Uint8Array([2]));
    expect(dom.revokeObjectURL).toHaveBeenCalledWith("blob:url");
    const second = dom.appended[1] as { fire(type: string): void; contentWindow: { print: ReturnType<typeof vi.fn> } | null };
    second.contentWindow!.print.mockImplementation(() => {
      throw new Error("bloqueado");
    });
    second.fire("load");
    await vi.advanceTimersByTimeAsync(250);
    await again;
    expect(open).toHaveBeenCalledWith("blob:url", "_blank", "noopener");

    const third = printPdf(new Uint8Array([3]));
    const frameless = dom.appended[2] as { fire(type: string): void; contentWindow: unknown };
    frameless.contentWindow = null;
    frameless.fire("load");
    await vi.advanceTimersByTimeAsync(250);
    await third;
    releasePrintFrame();
  });
});

// ── Installed app ────────────────────────────────────────────────────────

describe("installed app", () => {
  function stubWindow() {
    const handlers = new Map<string, (event: unknown) => void>();
    vi.stubGlobal("addEventListener", (type: string, handler: (event: unknown) => void) => handlers.set(type, handler));
    return handlers;
  }

  it("offers installation while the browser allows it", async () => {
    const handlers = stubWindow();
    const { pwa } = await import("./lib/pwa.svelte");
    pwa.init(() => {});
    await pwa.install();
    const prompt = { preventDefault: vi.fn(), prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: "accepted" }) };
    handlers.get("beforeinstallprompt")!(prompt);
    expect(pwa.canInstall).toBe(true);
    await pwa.install();
    expect(prompt.prompt).toHaveBeenCalled();
    expect(pwa.canInstall).toBe(false);
    handlers.get("beforeinstallprompt")!(prompt);
    handlers.get("appinstalled")!({});
    expect(pwa.canInstall).toBe(false);
  });

  it("opens files launched with the app", async () => {
    stubWindow();
    let consumer!: (params: unknown) => Promise<void>;
    vi.stubGlobal("launchQueue", { setConsumer: (fn: typeof consumer) => (consumer = fn) });
    const { pwa } = await import("./lib/pwa.svelte");
    const onFiles = vi.fn();
    pwa.init(onFiles);
    const file = new File(["x"], "a.pdf");
    await consumer({ files: [{ getFile: async () => file }, { kind: "file", getFile: async () => file }, { kind: "directory", getFile: async () => file }] });
    expect(onFiles).toHaveBeenCalledWith([file, file], expect.any(Array));
    await consumer({ files: [] });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("registers the service worker in production and offers updates", async () => {
    stubWindow();
    vi.stubEnv("PROD", true);
    const serviceWorkerHandlers = new Map<string, () => void>();
    const waiting = { postMessage: vi.fn() };
    const installing = { state: "installing", postMessage: vi.fn(), addEventListener: (_type: string, fn: () => void) => (installing.onstate = fn), onstate: () => {} };
    const registrationHandlers = new Map<string, () => void>();
    const registration = { waiting, installing, addEventListener: (type: string, fn: () => void) => registrationHandlers.set(type, fn) };
    const register = vi.fn(async () => registration);
    const serviceWorker = { register, controller: {}, addEventListener: (type: string, fn: () => void) => serviceWorkerHandlers.set(type, fn) };
    vi.stubGlobal("navigator", { serviceWorker });
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const { pwa } = await import("./lib/pwa.svelte");
    const { notifications } = await import("./lib/notifications.svelte");
    pwa.init(() => {});
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
    await vi.waitFor(() => expect(notifications.items.at(-1)?.message).toBe("Hay una versión nueva de ytaPDF."));
    notifications.items.at(-1)!.action!.run();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });

    registrationHandlers.get("updatefound")!();
    installing.onstate();
    installing.state = "installed";
    installing.onstate();
    expect(notifications.items.filter((n) => n.message === "Hay una versión nueva de ytaPDF.")).toHaveLength(2);
    registration.installing = null as never;
    registrationHandlers.get("updatefound")!();

    serviceWorkerHandlers.get("controllerchange")!();
    serviceWorkerHandlers.get("controllerchange")!();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("copes with browsers that refuse to register or have no service workers", async () => {
    stubWindow();
    vi.stubEnv("PROD", true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const register = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { serviceWorker: { register, controller: null } });
    const { pwa } = await import("./lib/pwa.svelte");
    pwa.init(() => {});
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    register.mockRejectedValueOnce(new Error("política"));
    pwa.init(() => {});
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("No se pudo activar el modo sin conexión:", expect.any(Error)));
    vi.stubGlobal("navigator", {});
    pwa.init(() => {});
  });

  it("only offers updates while a page is controlled", async () => {
    stubWindow();
    vi.stubEnv("PROD", true);
    const registrationHandlers = new Map<string, () => void>();
    const installing = { state: "installed", addEventListener: (_type: string, fn: () => void) => (installing.onstate = fn), onstate: () => {} };
    const registration = { waiting: {}, installing, addEventListener: (type: string, fn: () => void) => registrationHandlers.set(type, fn) };
    vi.stubGlobal("navigator", { serviceWorker: { register: async () => registration, controller: null, addEventListener: () => {} } });
    const { pwa } = await import("./lib/pwa.svelte");
    const { notifications } = await import("./lib/notifications.svelte");
    const before = notifications.items.length;
    pwa.init(() => {});
    await vi.waitFor(() => expect(registrationHandlers.has("updatefound")).toBe(true));
    registrationHandlers.get("updatefound")!();
    installing.onstate();
    expect(notifications.items.length).toBe(before);
  });

  it("takes files shared with the app from its cache", async () => {
    const { takeSharedFiles } = await import("./lib/pwa.svelte");
    expect(await takeSharedFiles()).toEqual([]);
    const responses = new Map<string, Response | undefined>([
      ["a", new Response("uno", { headers: { "X-Nombre": "mi%20archivo.pdf", "Content-Type": "application/pdf" } })],
      ["b", new Response(new Uint8Array([1]))],
      ["c", undefined],
    ]);
    const cache = { keys: async () => [...responses.keys()], match: async (key: string) => responses.get(key), delete: vi.fn() };
    vi.stubGlobal("caches", { open: async () => cache });
    const files = await takeSharedFiles();
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["mi archivo.pdf", "application/pdf"],
      ["documento.pdf", ""],
    ]);
    expect(cache.delete).toHaveBeenCalledTimes(3);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("caches", { open: async () => Promise.reject(new Error("no")) });
    expect(await takeSharedFiles()).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });
});

// ── Entry point ──────────────────────────────────────────────────────────

describe("entry point", () => {
  it("mounts the app on #app", async () => {
    const mount = vi.fn(() => "app");
    vi.doMock("svelte", async (importOriginal) => ({ ...(await importOriginal<typeof import("svelte")>()), mount }));
    vi.doMock("./App.svelte", () => ({ default: "App" }));
    vi.doMock("./app.css", () => ({}));
    const target = {};
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? target : null) });
    const main = await import("./main");
    expect(mount).toHaveBeenCalledWith("App", { target });
    expect(main.default).toBe("app");
  });
});
