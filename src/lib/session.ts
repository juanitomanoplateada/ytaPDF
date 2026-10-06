import type { PageAnnotations, PageRef } from "./editor.svelte";
import type { ImageAsset } from "./images";
import type { FormValue } from "./pdfjs";

/**
 * Optional local copy of the work in progress, kept in this browser's
 * IndexedDB so it can be recovered after closing the tab by mistake. Nothing
 * leaves the device; passwords are never stored.
 */
export interface SavedSession {
  version: 1;
  savedAt: number;
  documentName: string;
  sources: { id: string; name: string; bytes: Uint8Array }[];
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  formValues: Record<string, Record<string, FormValue>>;
  images: ({ url: string } & ImageAsset)[];
}

export interface SessionSummary {
  documentName: string;
  savedAt: number;
  pageCount: number;
}

const DB_NAME = "ytapdf";
const STORE = "session";
const KEY = "current";
const PREFERENCE = "ytapdf.recovery";

/** IndexedDB reports failures as a DOMException that may be missing (for example, on abort). */
function storageError(error: DOMException | null): Error {
  return error ?? new Error("No se pudo acceder al almacenamiento local.");
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error));
    });
  } finally {
    db.close();
  }
}

export async function saveSession(session: SavedSession): Promise<void> {
  await run("readwrite", (store) => store.put(session, KEY));
}

export async function loadSession(): Promise<SavedSession | null> {
  try {
    const session = await run<SavedSession | undefined>("readonly", (store) => store.get(KEY));
    return session?.version === 1 ? session : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(KEY));
  } catch {
    // Nothing to clear, or storage unavailable (private mode).
  }
}

export function summarize(session: SavedSession): SessionSummary {
  return { documentName: session.documentName, savedAt: session.savedAt, pageCount: session.pages.length };
}

export function recoveryEnabled(): boolean {
  try {
    return localStorage.getItem(PREFERENCE) === "on";
  } catch {
    return false;
  }
}

export function setRecoveryEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(PREFERENCE, "on");
    else localStorage.removeItem(PREFERENCE);
  } catch {
    // Storage blocked: the preference simply does not persist.
  }
}
