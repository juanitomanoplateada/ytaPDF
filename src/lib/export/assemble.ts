import {
  degrees,
  EncryptedPDFError,
  PDFArray,
  PDFStream,
  type PDFObject,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFObjectCopier,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFTextField,
  type PDFField,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { FormValue } from "../pdfjs";

export interface ExportSource {
  id: string;
  bytes: Uint8Array;
  password?: string;
  pageCount: number;
}

/** A page taken from a source document, optionally rotated further. */
export interface SourcePlacement {
  kind?: "source";
  sourceId: string;
  sourceIndex: number;
  /** Clockwise degrees added to the page's own rotation. */
  rotation?: number;
  /** New crop box [x0, y0, x1, y1] in the page's user space. */
  crop?: [number, number, number, number];
}

/** A new, empty page of the given size, filled later with a rendered image. */
export interface RasterPlacement {
  kind: "raster";
  width: number;
  height: number;
}

export type PagePlacement = SourcePlacement | RasterPlacement;

export interface AssembleOptions {
  /** Values to write into each source's form fields, by source and field name. */
  formValues?: Record<string, Record<string, FormValue>>;
  /** Font for field appearances when values need characters beyond WinAnsi. */
  fieldFont?: (doc: PDFDocument) => Promise<PDFFont>;
}

export interface AssembledDocument {
  doc: PDFDocument;
  /** Output pages, aligned with the requested placements. */
  pages: PDFPage[];
  /** True when the first source was edited in place, keeping all its structure. */
  inPlace: boolean;
  /** Fields whose value could not be written. */
  failedFields: string[];
}

const isRaster = (placement: PagePlacement): placement is RasterPlacement => placement.kind === "raster";

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
 * re-attached so they stay fillable. Form values are written into each source
 * before its pages are copied, so the copies carry them.
 */
export async function assembleDocument(
  placements: PagePlacement[],
  sources: Map<string, ExportSource>,
  options: AssembleOptions = {},
): Promise<AssembledDocument> {
  if (placements.length === 0) throw new Error("El documento no tiene páginas.");
  const failedFields: string[] = [];
  const fill = async (doc: PDFDocument, sourceId: string) => {
    const values = options.formValues?.[sourceId];
    if (values && Object.keys(values).length > 0) {
      failedFields.push(...(await applyFormValues(doc, values, options.fieldFont)));
    }
  };

  const first = placements[0];
  const firstSource = isRaster(first) ? undefined : sources.get(first.sourceId);
  const isUnchangedOrder =
    placements.length === firstSource?.pageCount &&
    placements.every((p, i) => !isRaster(p) && p.sourceId === firstSource.id && p.sourceIndex === i);

  if (isUnchangedOrder) {
    const doc = await loadSource(firstSource);
    await fill(doc, firstSource.id);
    const pages = doc.getPages();
    placements.forEach((placement, i) => rotate(pages[i], placement as SourcePlacement));
    return { doc, pages, inPlace: true, failedFields };
  }

  const doc = await PDFDocument.create({ updateMetadata: false });
  const loadedDocs = new Map<string, PDFDocument>();
  const load = (sourceId: string) => loadOnce(loadedDocs, sources, sourceId, fill);

  const copies = new Map<string, PDFPage[]>();
  for (const round of copyRounds(placements)) {
    for (const [sourceId, indices] of round) {
      const copied = await doc.copyPages(await load(sourceId), indices);
      copied.forEach((page, i) => {
        const key = `${sourceId}:${indices[i]}`;
        copies.set(key, [...(copies.get(key) ?? []), page]);
      });
    }
  }
  const loaded = [...loadedDocs.values()];

  const pages = placements.map((placement) => {
    if (isRaster(placement)) return doc.addPage([placement.width, placement.height]);
    // copyRounds copied each page as many times as it is placed.
    const page = copies.get(`${placement.sourceId}:${placement.sourceIndex}`)!.shift()!;
    rotate(page, placement);
    return doc.addPage(page);
  });

  reattachFormFields(
    doc,
    pages.filter((_, i) => !isRaster(placements[i])),
    loaded,
  );
  if (loaded[0]) copyDocumentInfo(loaded[0], doc);
  return { doc, pages, inPlace: false, failedFields };
}

/** A source parsed with pdf-lib (and its form values written) the first time it is needed. */
async function loadOnce(
  loaded: Map<string, PDFDocument>,
  sources: Map<string, ExportSource>,
  sourceId: string,
  fill: (doc: PDFDocument, sourceId: string) => Promise<void>,
): Promise<PDFDocument> {
  const known = loaded.get(sourceId);
  if (known) return known;
  const source = sources.get(sourceId);
  if (!source) throw new Error("Falta el documento de origen.");
  const doc = await loadSource(source);
  await fill(doc, sourceId);
  loaded.set(sourceId, doc);
  return doc;
}

/**
 * One copyPages call per source lets pages share fonts and images. A page
 * used more than once (duplicated) is copied again in a later round, with a
 * copier of its own, so each copy has its own content and can be drawn on
 * without the other one changing.
 */
function copyRounds(placements: PagePlacement[]): Map<string, number[]>[] {
  const rounds: Map<string, number[]>[] = [];
  const uses = new Map<string, number>();
  for (const placement of placements) {
    if (isRaster(placement)) continue;
    const key = `${placement.sourceId}:${placement.sourceIndex}`;
    const round = uses.get(key) ?? 0;
    uses.set(key, round + 1);
    rounds[round] ??= new Map();
    const indices = rounds[round].get(placement.sourceId) ?? [];
    indices.push(placement.sourceIndex);
    rounds[round].set(placement.sourceId, indices);
  }
  return rounds;
}

/** Applies the user's rotation and crop to an output page. */
function rotate(page: PDFPage, placement: SourcePlacement): void {
  if (placement.rotation) {
    page.setRotation(degrees((((page.getRotation().angle + placement.rotation) % 360) + 360) % 360));
  }
  if (placement.crop) {
    const [x0, y0, x1, y1] = placement.crop;
    page.setCropBox(x0, y0, x1 - x0, y1 - y0);
  }
}

/** Writes values into a document's form fields and regenerates their appearance. */
export async function applyFormValues(
  doc: PDFDocument,
  values: Record<string, FormValue>,
  fieldFont?: (doc: PDFDocument) => Promise<PDFFont>,
): Promise<string[]> {
  const form = doc.getForm();
  const failed: string[] = [];
  let needsUnicodeFont = false;

  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (writeField(field, value)) needsUnicodeFont = true;
    } catch (error) {
      console.error(`No se pudo rellenar el campo ${name}:`, error);
      failed.push(name);
    }
  }

  const font = needsUnicodeFont && fieldFont ? await fieldFont(doc) : undefined;
  try {
    form.updateFieldAppearances(font);
  } catch (error) {
    console.error("No se pudo actualizar la apariencia de los campos:", error);
  }
  return failed;
}

/** Characters outside WinAnsi, which the standard fonts cannot draw. */
const NON_WIN_ANSI = /[^\x20-\x7e\xa0-\xff\n\r]/;

/**
 * Writes one value into a field. Returns true when the text written needs a
 * font beyond WinAnsi for its appearance.
 */
function writeField(field: PDFField, value: FormValue): boolean {
  if (field instanceof PDFTextField) {
    const text = typeof value === "string" ? value : "";
    field.setText(text);
    return NON_WIN_ANSI.test(text);
  }
  if (field instanceof PDFCheckBox) {
    if (value === true) field.check();
    else field.uncheck();
  } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
    selectOptions(field, chosenOptions(value, field instanceof PDFOptionList));
  }
  return false;
}

/** Options a value selects: only lists take several, and an empty string selects none. */
function chosenOptions(value: FormValue, multiple: boolean): string[] {
  if (multiple && Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

/** Selects `options` in a choice field, or clears it when there are none. */
function selectOptions(field: PDFRadioGroup | PDFDropdown | PDFOptionList, options: string[]): void {
  if (options.length === 0) field.clear();
  else if (field instanceof PDFRadioGroup) field.select(options[0]);
  else field.select(options);
}

function reattachFormFields(doc: PDFDocument, pages: PDFPage[], sourceDocs: PDFDocument[]): void {
  const fields = new Set<PDFRef>();
  for (const page of pages) {
    for (const [ref, widget] of pageWidgets(doc, page)) {
      const field = topLevelField(doc, ref, widget);
      if (field) fields.add(field);
    }
  }
  if (fields.size === 0) return;

  const acroForm = doc.context.obj({ Fields: [...fields] });
  copyFormDefaults(doc, acroForm, sourceDocs);
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.register(acroForm));
}

/** Widget annotations of a page, with their references. */
function pageWidgets(doc: PDFDocument, page: PDFPage): [PDFRef, PDFDict][] {
  const annots = page.node.Annots();
  if (!annots) return [];
  const widgets: [PDFRef, PDFDict][] = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const annot = doc.context.lookupMaybe(ref, PDFDict);
    if (annot?.get(PDFName.of("Subtype")) === PDFName.of("Widget")) widgets.push([ref, annot]);
  }
  return widgets;
}

/** Climbs from a widget to the top-level field it belongs to, if it is part of one. */
function topLevelField(doc: PDFDocument, ref: PDFRef, widget: PDFDict): PDFRef | undefined {
  let fieldRef = ref;
  let field = widget;
  for (let depth = 0; depth < 32; depth++) {
    const parentRef = field.get(PDFName.of("Parent"));
    if (!(parentRef instanceof PDFRef)) break;
    const parent = doc.context.lookupMaybe(parentRef, PDFDict);
    if (!parent) break;
    fieldRef = parentRef;
    field = parent;
  }
  return field.has(PDFName.of("T")) || field.has(PDFName.of("FT")) ? fieldRef : undefined;
}

/** Copies the form-wide defaults (appearance, alignment, resources) of the first source with a form. */
function copyFormDefaults(doc: PDFDocument, acroForm: PDFDict, sourceDocs: PDFDocument[]): void {
  const sourceForm = sourceDocs
    .map((source) => ({ source, form: source.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict) }))
    .find(({ form }) => form !== undefined);
  if (!sourceForm) return;

  const { source } = sourceForm;
  // `find` kept an entry with a form.
  const form = sourceForm.form!;
  const copier = PDFObjectCopier.for(source.context, doc.context);
  for (const key of ["DA", "Q", "NeedAppearances", "DR"]) {
    const value = form.get(PDFName.of(key));
    if (value) acroForm.set(PDFName.of(key), copier.copy(value));
  }
}

// ── Document-wide options ───────────────────────────────────────────────────

/** Descriptive properties of a document, as viewers show them. */
export interface DocumentMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

const INFO_KEYS: [keyof DocumentMetadata, string][] = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
];

function infoDict(doc: PDFDocument): PDFDict | undefined {
  const info = doc.context.trailerInfo.Info;
  return info ? doc.context.lookupMaybe(info, PDFDict) : undefined;
}

/**
 * Drops the XMP metadata stream. pdf-lib writes every object it holds, even
 * unreferenced ones, so the object itself is deleted, not only the link.
 */
function removeXmp(doc: PDFDocument): void {
  const ref = doc.catalog.get(PDFName.of("Metadata"));
  doc.catalog.delete(PDFName.of("Metadata"));
  if (ref instanceof PDFRef) doc.context.delete(ref);
}

/**
 * Writes the properties the user set; empty ones are removed. The XMP stream
 * repeats the old values and some viewers prefer it, so it goes too.
 */
export function applyMetadata(doc: PDFDocument, metadata: DocumentMetadata): void {
  for (const [field, key] of INFO_KEYS) {
    const value = metadata[field].trim();
    if (!value) {
      infoDict(doc)?.delete(PDFName.of(key));
    } else if (field === "title") {
      doc.setTitle(value);
    } else if (field === "author") {
      doc.setAuthor(value);
    } else if (field === "subject") {
      doc.setSubject(value);
    } else {
      doc.setKeywords([value]);
    }
  }
  removeXmp(doc);
}

/** Removes every property: title, author, dates, producing software and XMP. */
export function stripMetadata(doc: PDFDocument): void {
  removeXmp(doc);
  const info = doc.context.trailerInfo.Info;
  doc.context.trailerInfo.Info = undefined;
  if (info instanceof PDFRef) doc.context.delete(info);
}

/**
 * Draws the form fields into the page content and removes them, so their
 * values can no longer be changed. Fields keep the appearance they have.
 */
export function flattenForm(doc: PDFDocument): void {
  if (!doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)) return;
  const form = doc.getForm();
  if (form.getFields().length > 0) {
    try {
      form.flatten();
    } catch (error) {
      // Regenerating a missing appearance can fail (characters the default
      // font lacks): flatten what each field already shows.
      console.error("No se pudieron regenerar todos los campos al aplanar:", error);
      form.flatten({ updateFieldAppearances: false });
    }
  }
  doc.catalog.delete(PDFName.of("AcroForm"));
}

/**
 * Deletes the objects nothing in the document points to any more: content
 * streams that were replaced, annotations that were removed, images no page
 * draws. A viewer never shows them, but they would still be in the file.
 */
export function removeUnreachableObjects(doc: PDFDocument): number {
  const { context } = doc;
  const reachable = reachableObjects(doc);
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (reachable.has(ref.toString())) continue;
    context.delete(ref);
    removed++;
  }
  return removed;
}

/** The objects a direct object points to, or contains. */
function childrenOf(object: PDFObject | undefined): (PDFObject | undefined)[] {
  if (object instanceof PDFDict) return [...object.entries()].map(([, value]) => value);
  if (object instanceof PDFArray) return object.asArray();
  if (object instanceof PDFStream) return [object.dict];
  return [];
}

/** References (as text) of every object reachable from the trailer. */
function reachableObjects(doc: PDFDocument): Set<string> {
  const { context } = doc;
  const reachable = new Set<string>();
  const trailer = context.trailerInfo;
  const pending: (PDFObject | undefined)[] = [trailer.Root, trailer.Info, trailer.Encrypt, trailer.ID];
  while (pending.length > 0) {
    const object = pending.pop();
    if (!(object instanceof PDFRef)) {
      pending.push(...childrenOf(object));
      continue;
    }
    const id = object.toString();
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(context.lookup(object));
  }
  return reachable;
}

/**
 * Encrypts the document with AES-256. The same password opens it and grants
 * every permission: the goal is privacy, not restricting the recipient.
 */
export function protectDocument(doc: PDFDocument, password: string): void {
  doc.encrypt({
    userPassword: password,
    ownerPassword: password,
    permissions: {
      printing: "highResolution",
      modifying: true,
      copying: true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: true,
    },
  });
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
