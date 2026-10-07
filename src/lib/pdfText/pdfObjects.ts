import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFObject,
} from "@cantoo/pdf-lib";

/** Small helpers over pdf-lib's object model. */

export const N = (name: string) => PDFName.of(name);

export function resolve(context: PDFContext, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

export function numberOf(context: PDFContext, value: PDFObject | undefined, fallback = 0): number {
  const resolved = resolve(context, value);
  return resolved instanceof PDFNumber ? resolved.asNumber() : fallback;
}

export function nameOf(context: PDFContext, value: PDFObject | undefined): string | undefined {
  const resolved = resolve(context, value);
  return resolved instanceof PDFName ? resolved.decodeText() : undefined;
}

export function dictOf(context: PDFContext, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = resolve(context, value);
  if (resolved instanceof PDFDict) return resolved;
  if (resolved instanceof PDFStream) return resolved.dict;
  return undefined;
}

export function arrayOf(context: PDFContext, value: PDFObject | undefined): PDFArray | undefined {
  const resolved = resolve(context, value);
  return resolved instanceof PDFArray ? resolved : undefined;
}

export function numbersOf(context: PDFContext, value: PDFObject | undefined): number[] | undefined {
  const array = arrayOf(context, value);
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) out.push(numberOf(context, array.get(i)));
  return out;
}

export function stringBytes(context: PDFContext, value: PDFObject | undefined): Uint8Array | undefined {
  const resolved = resolve(context, value);
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) return resolved.asBytes();
  return undefined;
}

/** The decoded bytes of a stream, or `undefined` if its filters are not supported. */
export function streamBytes(stream: PDFStream): Uint8Array | undefined {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
    return stream.getContents();
  } catch {
    return undefined;
  }
}

/** Raw bytes of a font program (FontFile*), decoded. */
export function streamOf(context: PDFContext, value: PDFObject | undefined): PDFStream | undefined {
  const resolved = resolve(context, value);
  return resolved instanceof PDFStream ? resolved : undefined;
}

/** A key that identifies an object: its reference when indirect. */
export function objectId(value: PDFObject | undefined, fallback: string): string {
  return value instanceof PDFRef ? value.toString() : fallback;
}
