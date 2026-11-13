import type { SaveHandle } from "./deliver";
import { t } from "./i18n.svelte";
import { notifications } from "./notifications.svelte";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface LaunchParams {
  files: (SaveHandle & { kind?: string; getFile(): Promise<File> })[];
}

/**
 * Installation as an app and offline support. The service worker is only
 * registered in production builds, where asset names are stable per version.
 */
class Pwa {
  canInstall = $state(false);
  #prompt: InstallPromptEvent | null = null;

  /**
   * `onFiles` receives the files opened with the installed app and their
   * handles, through which Save can write back to the same file.
   */
  init(onFiles: (files: File[], handles: SaveHandle[]) => void): void {
    globalThis.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      this.#prompt = event as InstallPromptEvent;
      this.canInstall = true;
    });
    globalThis.addEventListener("appinstalled", () => {
      this.#prompt = null;
      this.canInstall = false;
    });

    // PDFs opened from the operating system with the installed app.
    const launchQueue = (globalThis as unknown as { launchQueue?: { setConsumer(fn: (params: LaunchParams) => void): void } })
      .launchQueue;
    launchQueue?.setConsumer(async (params) => {
      const handles = params.files.filter((handle) => handle.kind === undefined || handle.kind === "file");
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      if (files.length > 0) onFiles(files, handles);
    });

    if (import.meta.env.PROD && "serviceWorker" in navigator) void this.#register();
  }

  async install(): Promise<void> {
    const prompt = this.#prompt;
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    this.#prompt = null;
    this.canInstall = false;
  }

  async #register(): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
      // Some browsers (or policies) allow the API but refuse to register.
      if (!registration) return;
      const offerUpdate = (worker: ServiceWorker) => {
        notifications.push("info", t("Hay una versión nueva de ytaPDF."), {
          label: t("Actualizar"),
          run: () => worker.postMessage({ type: "SKIP_WAITING" }),
        });
      };
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (error) {
      console.error("No se pudo activar el modo sin conexión:", error);
    }
  }
}

export const pwa = new Pwa();

/** Cache where the service worker leaves files shared with the installed app (see sw.js). */
const SHARED_CACHE = "ytapdf-compartidos";

/**
 * Files another app shared with ytaPDF ("Share" on Android). The service
 * worker receives them, keeps them here and opens the app; they are removed
 * as soon as they are read.
 */
export async function takeSharedFiles(): Promise<File[]> {
  if (typeof caches === "undefined") return [];
  try {
    const cache = await caches.open(SHARED_CACHE);
    const files: File[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      await cache.delete(request);
      if (!response) continue;
      const name = decodeURIComponent(response.headers.get("X-Nombre") ?? "documento.pdf");
      files.push(new File([await response.blob()], name, { type: response.headers.get("Content-Type") ?? "" }));
    }
    return files;
  } catch (error) {
    console.error("No se pudieron leer los archivos compartidos:", error);
    return [];
  }
}
