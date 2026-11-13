import type { OcrPage } from "./ocrText";
import type { PageDecorations } from "./decorations";
import type { PageAnnotations, PageRef } from "./editor.svelte";
import type { ImageAsset } from "./images";
import type { FormValue } from "./pdfjs";

/**
 * Works kept in this browser's IndexedDB. A work is saved on purpose (it
 * stays until the user deletes it) or, with recovery on, as a temporary copy
 * that is deleted when the document is closed normally and offered back if
 * the tab closed by mistake. Nothing leaves the device; passwords are never
 * stored.
 */
export interface SavedSession {
  version: 1;
  /** Identifies the work; sessions from before several works were kept have none. */
  id?: string;
  savedAt: number;
  documentName: string;
  /** Saved on purpose: kept until deleted. Otherwise only a recovery copy. */
  kept?: boolean;
  sources: { id: string; name: string; bytes: Uint8Array }[];
  pages: PageRef[];
  annotations: Record<string, PageAnnotations>;
  formValues: Record<string, Record<string, FormValue>>;
  images: ({ url: string } & ImageAsset)[];
  decorations?: PageDecorations | null;
  /** Text recognised on scanned pages, by source page. */
  ocr?: Record<string, OcrPage>;
}

export interface SessionSummary {
  id: string;
  documentName: string;
  savedAt: number;
  pageCount: number;
  kept: boolean;
}

const DB_NAME = "ytapdf";
const STORE = "session";
/** Summaries of every work, so listing them does not load their PDFs. */
const INDEX = "index";
/** Key of the single recovery copy kept before works had ids. */
const LEGACY = "current";
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

export function summarize(session: SavedSession): SessionSummary {
  return {
    id: session.id ?? LEGACY,
    documentName: session.documentName,
    savedAt: session.savedAt,
    pageCount: session.pages.length,
    kept: !!session.kept,
  };
}

async function readIndex(): Promise<SessionSummary[]> {
  const index = await run<SessionSummary[] | undefined>("readonly", (store) => store.get(INDEX));
  if (Array.isArray(index)) return index;
  // First use after several works were introduced: list the old recovery copy.
  const legacy = await run<SavedSession | undefined>("readonly", (store) => store.get(LEGACY));
  return legacy?.version === 1 ? [summarize(legacy)] : [];
}

async function writeIndex(index: SessionSummary[]): Promise<void> {
  await run("readwrite", (store) => store.put(index, INDEX));
}

/** Saved works, newest first. */
export async function listSessions(): Promise<SessionSummary[]> {
  try {
    return (await readIndex()).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function saveSession(session: SavedSession & { id: string }): Promise<void> {
  await run("readwrite", (store) => store.put(session, session.id));
  const index = (await readIndex()).filter((entry) => entry.id !== session.id);
  await writeIndex([summarize(session), ...index]);
}

export async function loadSession(id: string): Promise<SavedSession | null> {
  try {
    const session = await run<SavedSession | undefined>("readonly", (store) => store.get(id));
    return session?.version === 1 ? { ...session, id } : null;
  } catch {
    return null;
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(id));
    await writeIndex((await readIndex()).filter((entry) => entry.id !== id));
  } catch {
    // Nothing to delete, or storage unavailable (private mode).
  }
}

/** Deletes every recovery copy (works saved on purpose stay). */
export async function clearRecoveryCopies(): Promise<void> {
  for (const entry of await listSessions()) {
    if (!entry.kept) await deleteSession(entry.id);
  }
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
