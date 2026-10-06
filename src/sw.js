// @ts-nocheck — plain service worker script, not part of the app bundle.
// Service worker template. The `service-worker` plugin in vite.config.ts
// fills in the build version and the list of files to precache.

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const SHELL = `ytapdf-shell-${VERSION}`;
const RUNTIME = `ytapdf-runtime-${VERSION}`;

globalThis.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)));
});

globalThis.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("ytapdf-") && key !== SHELL && key !== RUNTIME) await caches.delete(key);
      }
      await globalThis.clients.claim();
    })(),
  );
});

// The page asks for this when the user accepts the update. Only pages of this
// app may ask.
globalThis.addEventListener("message", (event) => {
  if (event.origin !== globalThis.location.origin) return;
  if (event.data?.type === "SKIP_WAITING") globalThis.skipWaiting();
});

globalThis.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== globalThis.location.origin) return;

  // Pages: network first so updates arrive, cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/index.html")) ?? Response.error()),
    );
    return;
  }

  // Code, fonts and PDF.js assets: cache first, keeping what gets downloaded.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/pdfjs/"))) {
        const cache = await caches.open(RUNTIME);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
