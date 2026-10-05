import {
  EncryptedPDFError,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFRef,
  type PDFPage,
} from "@cantoo/pdf-lib";

export interface ExportSource {
  id: string;
  bytes: Uint8Array;
  password?: string;
  pageCount: number;
}

export interface PagePlacement {
  sourceId: string;
  sourceIndex: number;
}

export interface AssembledDocument {
  doc: PDFDocument;
  /** Output pages, aligned with the requested placements. */
  pages: PDFPage[];
  /** True when the first source was edited in place, keeping all its structure. */
  inPlace: boolean;
}

/**
 * Parses a source with pdf-lib, decrypting it when needed. Encrypted files
 * that open without a password (owner-password only) use the empty password.
 */
export async function loadSource(source: ExportSource): Promise<PDFDocument> {
  const options = { updateMetadata: false };
  try {
    return await PDFDocument.load(source.bytes, { ...options, password: source.password });
  } catch (error) {
    if (error instanceof EncryptedPDFError && source.password === undefined) {
      return PDFDocument.load(source.bytes, { ...options, password: "" });
    }
    throw error;
  }
}

/**
 * Builds the output document for the requested page order.
 *
 * When the order is exactly the first source's pages, that document is edited
 * in place so bookmarks, links, forms, tags and metadata survive untouched.
 * Otherwise the pages are copied into a new document, which keeps deleted
 * pages out of the file, and the form fields on the copied pages are
 * re-attached so they stay fillable.
 */
export async function assembleDocument(
  placements: PagePlacement[],
  sources: Map<string, ExportSource>,
): Promise<AssembledDocument> {
  if (placements.length === 0) throw new Error("El documento no tiene páginas.");
  const first = sources.get(placements[0].sourceId);
  if (!first) throw new Error("Falta el documento de origen.");

  const isUnchangedOrder =
    placements.length === first.pageCount &&
    placements.every((p, i) => p.sourceId === first.id && p.sourceIndex === i);

  if (isUnchangedOrder) {
    const doc = await loadSource(first);
    return { doc, pages: doc.getPages(), inPlace: true };
  }

  const doc = await PDFDocument.create({ updateMetadata: false });

  // One copyPages call per source lets pages share fonts and images.
  const bySource = new Map<string, number[]>();
  for (const { sourceId, sourceIndex } of placements) {
    const indices = bySource.get(sourceId) ?? [];
    indices.push(sourceIndex);
    bySource.set(sourceId, indices);
  }

  const loaded: PDFDocument[] = [];
  const copies = new Map<string, PDFPage[]>();
  for (const [sourceId, indices] of bySource) {
    const source = sources.get(sourceId);
    if (!source) throw new Error("Falta el documento de origen.");
    const sourceDoc = await loadSource(source);
    loaded.push(sourceDoc);
    const copied = await doc.copyPages(sourceDoc, indices);
    copied.forEach((page, i) => {
      const key = `${sourceId}:${indices[i]}`;
      copies.set(key, [...(copies.get(key) ?? []), page]);
    });
  }

  const pages = placements.map(({ sourceId, sourceIndex }) => {
    const page = copies.get(`${sourceId}:${sourceIndex}`)?.shift();
    if (!page) throw new Error("No se pudo copiar una página.");
    return doc.addPage(page);
  });

  reattachFormFields(doc, pages, loaded);
  copyDocumentInfo(loaded[0], doc);
  return { doc, pages, inPlace: false };
}

function reattachFormFields(doc: PDFDocument, pages: PDFPage[], sourceDocs: PDFDocument[]): void {
  const fields = new Set<PDFRef>();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const annot = doc.context.lookupMaybe(ref, PDFDict);
      if (!annot || annot.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;

      // Climb from the widget to the top-level field it belongs to.
      let fieldRef = ref;
      let field = annot;
      for (let depth = 0; depth < 32; depth++) {
        const parentRef = field.get(PDFName.of("Parent"));
        const parent = parentRef instanceof PDFRef ? doc.context.lookupMaybe(parentRef, PDFDict) : undefined;
        if (!parent || !(parentRef instanceof PDFRef)) break;
        fieldRef = parentRef;
        field = parent;
      }
      if (field.has(PDFName.of("T")) || field.has(PDFName.of("FT"))) fields.add(fieldRef);
    }
  }
  if (fields.size === 0) return;

  const acroForm = doc.context.obj({ Fields: [...fields] }) as PDFDict;
  const sourceForm = sourceDocs
    .map((source) => ({ source, form: source.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict) }))
    .find(({ form }) => form !== undefined);

  if (sourceForm?.form) {
    const { source, form } = sourceForm;
    const copier = PDFObjectCopier.for(source.context, doc.context);
    for (const key of ["DA", "Q", "NeedAppearances"]) {
      const value = form.get(PDFName.of(key));
      if (value) acroForm.set(PDFName.of(key), copier.copy(value));
    }
    const resources = form.get(PDFName.of("DR"));
    if (resources) acroForm.set(PDFName.of("DR"), copier.copy(resources));
  }

  doc.catalog.set(PDFName.of("AcroForm"), doc.context.register(acroForm));
}

function copyDocumentInfo(from: PDFDocument, to: PDFDocument): void {
  const title = from.getTitle();
  const author = from.getAuthor();
  const subject = from.getSubject();
  const keywords = from.getKeywords();
  if (title) to.setTitle(title);
  if (author) to.setAuthor(author);
  if (subject) to.setSubject(subject);
  if (keywords) to.setKeywords([keywords]);
}
