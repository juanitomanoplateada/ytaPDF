/**
 * Ways to hand an exported file to the user: download, save with the
 * browser's file picker (or over a file the app opened), share and print.
 * Everything stays local: sharing goes through the operating system.
 */

/** The part of the File System Access API the app uses (Chromium). */
export interface SaveHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
}

interface FilePickerWindow {
  showSaveFilePicker?(options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<SaveHandle>;
}

export const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  zip: "application/zip",
} as const;

const DESCRIPTIONS: Record<string, string> = {
  [MIME.pdf]: "Documento PDF",
  [MIME.png]: "Imagen PNG",
  [MIME.jpeg]: "Imagen JPG",
  [MIME.zip]: "Archivo ZIP",
};

const EXTENSIONS: Record<string, string> = {
  [MIME.pdf]: ".pdf",
  [MIME.png]: ".png",
  [MIME.jpeg]: ".jpg",
  [MIME.zip]: ".zip",
};

export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const canPickSaveLocation =
  typeof (globalThis as unknown as FilePickerWindow).showSaveFilePicker === "function";

/**
 * Asks where to save. Resolves with the chosen file, or `null` if the user
 * cancelled. Must be called while the click that asked for it is still recent.
 */
export async function pickSaveLocation(fileName: string, type: string): Promise<SaveHandle | null> {
  const picker = (globalThis as unknown as FilePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker.call(globalThis, {
      suggestedName: fileName,
      types: [{ description: DESCRIPTIONS[type] ?? "Archivo", accept: { [type]: [EXTENSIONS[type] ?? ""] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/** Asks for permission to overwrite a file the app was given. */
export async function ensureWritable(handle: SaveHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: "readwrite" })) === "granted") return true;
    const state = await handle.requestPermission?.({ mode: "readwrite" });
    return state === undefined || state === "granted";
  } catch {
    return false;
  }
}

export async function writeToHandle(handle: SaveHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(bytes as BlobPart);
  await writable.close();
}

/** Whether this browser can share files (mobile browsers, Safari, Chromium on Windows…). */
export const canShareFiles = (() => {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "prueba.pdf", { type: MIME.pdf })] })
    );
  } catch {
    return false;
  }
})();

/** Opens the system's share sheet. Resolves false if the user closed it. */
export async function shareFile(bytes: Uint8Array, fileName: string, type: string): Promise<boolean> {
  const file = new File([bytes as BlobPart], fileName, { type });
  try {
    await navigator.share({ files: [file], title: fileName });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    throw error;
  }
}

let printFrame: HTMLIFrameElement | null = null;
let printUrl: string | null = null;

/** Removes the frame of the last print, if any. */
export function releasePrintFrame(): void {
  printFrame?.remove();
  printFrame = null;
  if (printUrl) URL.revokeObjectURL(printUrl);
  printUrl = null;
}

/**
 * Prints a PDF with the browser's own viewer, from a hidden frame. The frame
 * stays until the next print: removing it while the dialog is open would
 * cancel the print in some browsers. Where the viewer cannot print from a
 * frame, the PDF opens in a new tab instead.
 */
export async function printPdf(bytes: Uint8Array): Promise<void> {
  releasePrintFrame();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME.pdf }));
  printUrl = url;
  const frame = document.createElement("iframe");
  frame.title = "Impresión";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
  printFrame = frame;
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  frame.src = url;
  document.body.appendChild(frame);
  await loaded;
  // The viewer needs a moment after loading before it can print.
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch {
    window.open(url, "_blank", "noopener");
  }
}
