import { notifications } from "./notifications.svelte";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface LaunchParams {
  files: { getFile(): Promise<File> }[];
}

/**
 * Installation as an app and offline support. The service worker is only
 * registered in production builds, where asset names are stable per version.
 */
class Pwa {
  canInstall = $state(false);
  #prompt: InstallPromptEvent | null = null;

  init(onFiles: (files: File[]) => void): void {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      this.#prompt = event as InstallPromptEvent;
      this.canInstall = true;
    });
    window.addEventListener("appinstalled", () => {
      this.#prompt = null;
      this.canInstall = false;
    });

    // PDFs opened from the operating system with the installed app.
    const launchQueue = (window as unknown as { launchQueue?: { setConsumer(fn: (params: LaunchParams) => void): void } })
      .launchQueue;
    launchQueue?.setConsumer(async (params) => {
      const files = await Promise.all(params.files.map((handle) => handle.getFile()));
      if (files.length > 0) onFiles(files);
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
        notifications.push("info", "Hay una versión nueva de ytaPDF.", {
          label: "Actualizar",
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
