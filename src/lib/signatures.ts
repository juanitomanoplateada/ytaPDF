import type { SignatureContent } from "./editor.svelte";

export type SavedSignature = SignatureContent & { id: string };

const STORAGE_KEY = "ytapdf.signatures";
const LIMIT = 5;

type PathCommand = [string, ...number[]];

/**
 * Joins the strokes of a drawing into one path and moves it so its bounding
 * box starts at the origin. `bounds` is the union of the strokes' boxes.
 */
export function combineStrokes(
  strokes: PathCommand[][],
  bounds: { left: number; top: number; width: number; height: number },
  padding: number,
): { path: string; width: number; height: number } {
  const dx = padding - bounds.left;
  const dy = padding - bounds.top;
  const round = (n: number) => Math.round(n * 100) / 100;
  const path = strokes
    .flat()
    .map(([op, ...args]) => [op, ...args.map((value, i) => round(value + (i % 2 === 0 ? dx : dy)))].join(" "))
    .join(" ");
  return { path, width: round(bounds.width + padding * 2), height: round(bounds.height + padding * 2) };
}

/** Signatures the user chose to keep, stored only in this browser. */
export function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as SavedSignature[]) : [];
    return Array.isArray(list)
      ? list.filter((s) => typeof (s as { path?: unknown }).path === "string" || typeof (s as { image?: unknown }).image === "string")
      : [];
  } catch {
    return [];
  }
}

function store(list: SavedSignature[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked or full: the signature is used but not remembered.
  }
}

/** Keeps up to five signatures and five sets of initials, newest first. */
export function saveSignature(signature: SignatureContent): SavedSignature[] {
  const saved: SavedSignature = { ...signature, id: `firma-${Date.now().toString(36)}` };
  const same = (s: SavedSignature) => !!s.initials === !!signature.initials;
  const previous = loadSavedSignatures();
  const list = [saved, ...previous.filter(same).slice(0, LIMIT - 1), ...previous.filter((s) => !same(s))];
  store(list);
  return list;
}

export function deleteSavedSignature(id: string): SavedSignature[] {
  const list = loadSavedSignatures().filter((s) => s.id !== id);
  store(list);
  return list;
}
