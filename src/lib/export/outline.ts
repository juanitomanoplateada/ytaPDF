import { PDFHexString, PDFName, PDFNull, PDFNumber, type PDFDocument, type PDFPage, type PDFRef } from "@cantoo/pdf-lib";
import type { OutlineEntry } from "../outline";

/**
 * Writes the document outline (bookmarks). pdf-lib has no API for it, so the
 * tree of outline dictionaries is built by hand: each entry links to its
 * parent, siblings and children, and opens its page at the given height.
 * Entries start collapsed; the top level is visible.
 */
export function writeOutline(doc: PDFDocument, pages: PDFPage[], entries: OutlineEntry[]): void {
  if (entries.length === 0) return;
  const context = doc.context;
  const root = context.nextRef();

  const build = (items: OutlineEntry[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = items.map(() => context.nextRef());
    items.forEach((item, i) => {
      const page = pages[item.pageIndex];
      const dict = context.obj({});
      dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
      dict.set(PDFName.of("Parent"), parent);
      dict.set(
        PDFName.of("Dest"),
        context.obj([page.ref, PDFName.of("XYZ"), PDFNull, item.top === null ? PDFNull : PDFNumber.of(item.top), PDFNull]),
      );
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < items.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      if (item.children.length > 0) {
        const { first, last } = build(item.children, refs[i]);
        dict.set(PDFName.of("First"), first);
        dict.set(PDFName.of("Last"), last);
        // Negative: collapsed, with this many entries shown when opened.
        dict.set(PDFName.of("Count"), PDFNumber.of(-item.children.length));
      }
      context.assign(refs[i], dict);
    });
    // Only called with entries, so there is always a last one.
    return { first: refs[0], last: refs.at(-1)! };
  };

  const { first, last } = build(entries, root);
  context.assign(
    root,
    context.obj({ Type: "Outlines", First: first, Last: last, Count: PDFNumber.of(entries.length) }),
  );
  doc.catalog.set(PDFName.of("Outlines"), root);
}
