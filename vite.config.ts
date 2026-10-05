/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Serves PDF.js runtime assets (CMaps, standard font data, WASM decoders and
 * ICC profiles) from this origin instead of a CDN, so opening a document never
 * triggers a third-party request. They are emitted to `dist/pdfjs/`.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const files = new Set(
    dirs.flatMap((dir) =>
      readdirSync(join(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${dir}/${entry.name}`),
    ),
  );

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        // Only whitelisted files are served, which also rules out path traversal.
        if (!files.has(path)) return next();
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm")
            ? "application/wasm"
            : path.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
        );
        createReadStream(join(root, path)).pipe(res);
      });
    },
    generateBundle() {
      for (const path of files) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/${path}`,
          source: readFileSync(join(root, path)),
        });
      }
    },
  };
}

/**
 * Emits `sw.js`, a service worker that precaches this build's app shell and
 * code (so the app opens and exports offline) and caches PDF.js assets and
 * fonts the first time they are used.
 */
function serviceWorker(): Plugin {
  const publicFiles = ["/", "/index.html", "/paty.png", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const precache = [
        ...publicFiles,
        ...Object.keys(bundle)
          .filter((file) => !file.startsWith("pdfjs/") && !file.endsWith(".map") && !file.endsWith(".ttf") && file !== "index.html")
          .map((file) => `/${file}`),
      ];
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./src/sw.js", import.meta.url), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), pdfjsAssets(), serviceWorker()],
  build: {
    // PDF.js, pdf-lib and Fabric are large by nature; split them so the app
    // shell stays small and vendors are cached independently.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ["pdfjs-dist"],
          "pdf-lib": ["@cantoo/pdf-lib"],
          fabric: ["fabric"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
