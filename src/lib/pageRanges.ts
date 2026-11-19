/**
 * Page ranges typed by the user, such as "1-3, 5, 8-". Page numbers are
 * 1-based in the text and 0-based in the result.
 */

/**
 * Groups of pages, or an error: a Spanish message template (the interface
 * translates it) with its placeholders in `params`.
 */
export type RangeResult =
  | { groups: number[][]; error?: never; params?: never }
  | { groups?: never; error: string; params?: Record<string, string | number> };

/** The error of a result with its placeholders filled in (untranslated). */
export function rangeErrorText(result: RangeResult): string | undefined {
  return result.error?.replaceAll(/\{(\w+)\}/g, (match, name: string) => String(result.params?.[name] ?? match));
}

/**
 * Each comma-separated part becomes a group: "1-3, 4-6" gives two groups.
 * An open end ("8-") runs to the last page and an open start ("-3") from the
 * first; a descending range ("5-3") lists its pages in that order.
 */
export function parsePageRanges(text: string, total: number): RangeResult {
  const parts = text
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { error: "Escribe al menos una página o un rango, por ejemplo 1-3, 5." };
  const groups: number[][] = [];
  for (const part of parts) {
    const group = parsePart(part, total);
    if (!Array.isArray(group)) return group;
    groups.push(group);
  }
  return { groups };
}

/** The 0-based pages of one part ("3", "1-4", "8-", "-3", "5-3"), or the error it has. */
function parsePart(part: string, total: number): number[] | RangeResult {
  const match = /^(\d*)\s*(?:[-–—]\s*(\d*))?$/.exec(part);
  if (!match || (match[1] === "" && !match[2])) {
    return { error: "«{part}» no es una página ni un rango válido.", params: { part } };
  }
  const from = match[1] === "" ? 1 : Number(match[1]);
  let to = from;
  if (match[2] !== undefined) to = match[2] === "" ? total : Number(match[2]);
  const missing = [from, to].find((page) => page < 1 || page > total);
  if (missing !== undefined) {
    return {
      error:
        total === 1
          ? "La página {page} no existe: el documento tiene 1 página."
          : "La página {page} no existe: el documento tiene {total} páginas.",
      params: { page: missing, total },
    };
  }
  const step = to >= from ? 1 : -1;
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, k) => from + k * step - 1);
}

/** Splits `total` pages into consecutive groups of `size` (the last may be shorter). */
export function chunkPages(total: number, size: number): number[][] {
  const step = Math.max(1, Math.floor(size));
  const groups: number[][] = [];
  for (let start = 0; start < total; start += step) {
    groups.push(Array.from({ length: Math.min(step, total - start) }, (_, i) => start + i));
  }
  return groups;
}

/** "1-3" for consecutive pages, "1, 4, 6" otherwise (1-based). */
export function describePages(indices: number[]): string {
  if (indices.length === 0) return "";
  const consecutive = indices.every((index, i) => i === 0 || index === indices[i - 1] + 1);
  if (indices.length === 1) return `${indices[0] + 1}`;
  if (consecutive) return `${indices[0] + 1}-${indices.at(-1)! + 1}`;
  return indices.map((index) => index + 1).join(", ");
}

/** Removes characters that file systems reject and a trailing extension. */
export function sanitizeFileName(name: string, extension = "pdf"): string {
  return name
    .trim()
    .replace(new RegExp(String.raw`\.${extension}$`, "i"), "")
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replaceAll(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 180);
}
