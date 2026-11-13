import { PDFArray, PDFHexString, PDFName, PDFString, type PDFDocument, type PDFPage } from "@cantoo/pdf-lib";

/**
 * Notes and links are written as real PDF annotations, not drawn into the
 * page: other readers show notes as comments that can be opened, answered
 * and edited, and links as clickable areas.
 */

/** A rectangle [x0, y0, x1, y1] in the page's user space. */
export type UserRect = [number, number, number, number];

export interface NoteAnnotation {
  kind: "note";
  rect: UserRect;
  text: string;
  /** RGB, 0–1. */
  color: [number, number, number];
}

export interface LinkAnnotation {
  kind: "link";
  rect: UserRect;
  /** Web address, e-mail (mailto:) or phone (tel:). */
  url?: string;
  /** 0-based page of the exported document. */
  pageIndex?: number;
}

export type PageAnnotation = NoteAnnotation | LinkAnnotation;

/** Size of a note's icon on the page, in points. */
const NOTE_ICON = 20;

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** URIs in PDF are 7-bit ASCII: anything else is percent-encoded. */
function asciiUri(url: string): string {
  return url.replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char));
}

/** Adds notes and links to an exported page. `pages` are all the exported pages, for internal links. */
export function addPageAnnotations(doc: PDFDocument, page: PDFPage, annotations: PageAnnotation[], pages: PDFPage[]): number {
  const { context } = doc;
  const refs = [];
  const now = pdfDate(new Date());
  let n = 0;
  for (const annotation of annotations) {
    const [x0, y0, x1, y1] = annotation.rect;
    if (annotation.kind === "note") {
      if (!annotation.text.trim()) continue;
      // The icon goes at the note's top-left corner, as readers place them.
      const top = Math.max(y0, y1);
      const left = Math.min(x0, x1);
      const dict = context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [left, top - NOTE_ICON, left + NOTE_ICON, top],
        Contents: PDFHexString.fromText(annotation.text),
        Name: "Comment",
        C: annotation.color,
        Open: false,
        F: 28,
        M: PDFString.of(now),
        NM: PDFString.of(`ytapdf-note-${Date.now().toString(36)}-${n++}`),
      });
      refs.push(context.register(dict));
    } else {
      const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const target = annotation.pageIndex !== undefined ? pages[annotation.pageIndex] : undefined;
      if (target) {
        const dict = context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: rect,
          Border: [0, 0, 0],
          H: "I",
          F: 4,
          Dest: [target.ref, PDFName.of("Fit")],
        });
        refs.push(context.register(dict));
      } else if (annotation.url) {
        const action = context.obj({ S: "URI", URI: PDFString.of(asciiUri(annotation.url)) });
        const dict = context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], H: "I", F: 4, A: action });
        refs.push(context.register(dict));
      }
    }
  }
  if (refs.length === 0) return 0;
  const existing = page.node.lookup(PDFName.of("Annots"));
  const array = existing instanceof PDFArray ? existing : context.obj([]);
  for (const ref of refs) array.push(ref);
  page.node.set(PDFName.of("Annots"), array);
  return refs.length;
}
