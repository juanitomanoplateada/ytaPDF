import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Bookmarks (the PDF outline). Each source's outline is read with PDF.js and
 * tied to the editor's pages, so it follows them when they are reordered,
 * and the exported file gets an outline with the pages that remain.
 */

/** An outline entry of a source document, pointing to one of its pages. */
export interface SourceOutlineItem {
  title: string;
  /** 0-based page of the source, or null when the entry points nowhere usable. */
  pageIndex: number | null;
  /** Height of the target on the page (PDF user space), when the entry gives one. */
  top: number | null;
  children: SourceOutlineItem[];
}

/** A bookmark of the document being edited. */
export interface Bookmark {
  id: string;
  title: string;
  /** Page it opens, or null when that page is no longer in the document. */
  pageId: string | null;
  top: number | null;
  children: Bookmark[];
}

/** An outline entry of the exported file. */
export interface OutlineEntry {
  title: string;
  /** 0-based page of the exported file. */
  pageIndex: number;
  top: number | null;
  children: OutlineEntry[];
}

const MAX_ITEMS = 2000;
const MAX_DEPTH = 12;

interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineItem[];
}

export async function readOutline(pdf: PDFDocumentProxy): Promise<SourceOutlineItem[]> {
  let raw: RawOutlineItem[] | null;
  try {
    raw = (await pdf.getOutline()) as RawOutlineItem[] | null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let budget = MAX_ITEMS;

  const target = async (dest: RawOutlineItem["dest"]): Promise<{ pageIndex: number | null; top: number | null }> => {
    try {
      const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return { pageIndex: null, top: null };
      const [ref, mode, ...args] = explicit as [unknown, { name?: string } | undefined, ...unknown[]];
      let pageIndex: number | null = null;
      if (typeof ref === "number") pageIndex = ref;
      else if (ref && typeof ref === "object") pageIndex = await pdf.getPageIndex(ref as never);
      let top: unknown = null;
      if (mode?.name === "XYZ") top = args[1];
      else if (mode?.name === "FitH" || mode?.name === "FitBH") top = args[0];
      return { pageIndex, top: typeof top === "number" ? top : null };
    } catch {
      return { pageIndex: null, top: null };
    }
  };

  const walk = async (items: RawOutlineItem[], depth: number): Promise<SourceOutlineItem[]> => {
    const result: SourceOutlineItem[] = [];
    for (const item of items) {
      if (budget-- <= 0) break;
      const { pageIndex, top } = await target(item.dest);
      result.push({
        title: (item.title ?? "").trim() || "—",
        pageIndex,
        top,
        children: depth < MAX_DEPTH ? await walk(item.items ?? [], depth + 1) : [],
      });
    }
    return result;
  };
  return walk(raw, 0);
}

/**
 * Ties a source's outline to the editor's pages: `pageFor` gives the page now
 * showing a page index of that source (null when none does).
 */
export function tieOutline(
  sourceId: string,
  items: SourceOutlineItem[],
  pageFor: (pageIndex: number) => string | null,
  prefix = sourceId,
): Bookmark[] {
  return items.map((item, i) => ({
    id: `${prefix}:${i}`,
    title: item.title,
    pageId: item.pageIndex === null ? null : pageFor(item.pageIndex),
    top: item.top,
    children: tieOutline(sourceId, item.children, pageFor, `${prefix}:${i}`),
  }));
}

/**
 * Outline entries for an exported file. Bookmarks whose page was left out
 * disappear, and their children take their place.
 */
export function toOutlineEntries(bookmarks: Bookmark[], indexOf: (pageId: string) => number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const bookmark of bookmarks) {
    const children = toOutlineEntries(bookmark.children, indexOf);
    const index = bookmark.pageId ? indexOf(bookmark.pageId) : -1;
    if (index >= 0) entries.push({ title: bookmark.title, pageIndex: index, top: bookmark.top, children });
    else entries.push(...children);
  }
  return entries;
}
