import type { PDFDocument, PDFObject, PDFRef } from "@cantoo/pdf-lib";
import { loadSource } from "../export/assemble";

/**
 * Writes the objects changed or added since a document was loaded as an
 * incremental update appended to the bytes it was loaded from. Only the
 * update is new, so previewing an edited page does not rewrite the file.
 */

const encoder = new TextEncoder();

function lastStartXref(bytes: Uint8Array): number {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error("No se encontró la tabla de referencias del PDF.");
  return Number(last[1]);
}

function serialize(object: PDFObject): Uint8Array {
  const out = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(out, 0);
  return out;
}

/**
 * @param base Bytes the document was loaded from (unencrypted).
 * @param baseLargest Largest object number right after loading.
 * @param changed Existing objects that were modified (for example, pages).
 */
export async function appendUpdate(
  base: Uint8Array,
  doc: PDFDocument,
  baseLargest: number,
  changed: PDFRef[],
): Promise<Uint8Array> {
  await doc.flush();
  const { context } = doc;
  const objects = new Map<number, [PDFRef, PDFObject]>();
  for (const ref of changed) {
    const object = context.lookup(ref);
    if (object) objects.set(ref.objectNumber, [ref, object]);
  }
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (ref.objectNumber > baseLargest) objects.set(ref.objectNumber, [ref, object]);
  }

  const parts: Uint8Array[] = [encoder.encode("\n")];
  let offset = base.length + 1;
  const entries: { number: number; generation: number; offset: number }[] = [];
  for (const [ref, object] of [...objects.values()].sort((a, b) => a[0].objectNumber - b[0].objectNumber)) {
    const head = encoder.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const body = serialize(object);
    const tail = encoder.encode("\nendobj\n");
    entries.push({ number: ref.objectNumber, generation: ref.generationNumber, offset });
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  }

  // Cross-reference table: one subsection per run of consecutive numbers.
  let xref = "xref\n";
  for (let i = 0; i < entries.length; ) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1].number === entries[j].number + 1) j++;
    xref += `${entries[i].number} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      xref += `${String(entries[k].offset).padStart(10, "0")} ${String(entries[k].generation).padStart(5, "0")} n\r\n`;
    }
    i = j + 1;
  }

  const { Root, Info, ID } = context.trailerInfo;
  const size = Math.max(context.largestObjectNumber, ...entries.map((e) => e.number)) + 1;
  let trailer = `trailer\n<< /Size ${size}`;
  if (Root) trailer += ` /Root ${Root.toString()}`;
  if (Info) trailer += ` /Info ${Info.toString()}`;
  if (ID) trailer += ` /ID ${ID.toString()}`;
  trailer += ` /Prev ${lastStartXref(base)} >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(encoder.encode(xref), encoder.encode(trailer));

  const out = new Uint8Array(base.length + parts.reduce((sum, part) => sum + part.length, 0));
  out.set(base, 0);
  let position = base.length;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

/**
 * The bytes previews are built on: the document saved once by pdf-lib, which
 * removes encryption (new objects could not be encrypted) and leaves a clean
 * cross-reference table to append to. Object numbers are kept, so form
 * fields keep their identifiers.
 */
export async function normalizedBase(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const doc = await loadSource({ id: "", bytes, password, pageCount: 0 });
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
