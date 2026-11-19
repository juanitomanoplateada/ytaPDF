import forge from "node-forge";
import {
  PDFArray,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFDocument,
  type PDFPage,
} from "@cantoo/pdf-lib";

/**
 * Digital signatures with the user's certificate (a PKCS#12 file, .p12 or
 * .pfx). The certificate and its password stay in memory on this device.
 *
 * Signing works in two steps, as with any PDF signer: the document is saved
 * with an empty signature of fixed size (`addSignaturePlaceholder`), then the
 * bytes around that space are hashed and signed (CMS, SHA-256, detached) and
 * the signature is written into it (`signSavedPdf`). Anything changed in the
 * file after that is detected by every PDF reader.
 */

export interface SigningIdentity {
  key: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
  /** Other certificates of the file (the issuers), included so readers can build the chain. */
  chain: forge.pki.Certificate[];
}

export interface CertificateSummary {
  name: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

export type CertificateProblem = "password" | "format" | "no-key" | "unsupported-key";

export class CertificateError extends Error {
  constructor(readonly problem: CertificateProblem) {
    super(problem);
  }
}

export interface SignatureDetails {
  /** Why the document is signed ("Conforme", "Autor"…). */
  reason?: string;
  location?: string;
  contactInfo?: string;
  date?: Date;
}

/** Room for the signature: 16 KB fits a certificate chain of several levels. */
export const SIGNATURE_BYTES = 16384;
const BYTE_RANGE_PLACEHOLDER = "**********";

const toBinary = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  return out;
};

const fieldOf = (name: forge.pki.Certificate["subject"], key: string) =>
  (name.getField(key) as { value?: string } | null)?.value;

export function describeCertificate(certificate: forge.pki.Certificate): CertificateSummary {
  const subject = certificate.subject;
  const issuer = certificate.issuer;
  return {
    name: fieldOf(subject, "CN") ?? fieldOf(subject, "O") ?? "—",
    issuer: fieldOf(issuer, "CN") ?? fieldOf(issuer, "O") ?? "—",
    validFrom: certificate.validity.notBefore,
    validTo: certificate.validity.notAfter,
  };
}

/** Opens a PKCS#12 file. Throws `CertificateError` when it cannot be used. */
export function readPkcs12(bytes: Uint8Array, password: string): SigningIdentity {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(bytes)), false, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new CertificateError(/password|MAC/i.test(message) ? "password" : "format");
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBag = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)][0];
  const certificates = bagsOf(forge.pki.oids.certBag)
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => !!cert);
  if (!keyBag) throw new CertificateError("no-key");
  // forge reads RSA keys only: elliptic-curve keys come back empty.
  const key = keyBag.key;
  if (!key || certificates.length === 0) throw new CertificateError("unsupported-key");

  const own = certificates.find((cert) => {
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
    return publicKey.n?.equals(key.n) && publicKey.e?.equals(key.e);
  });
  if (!own) throw new CertificateError("no-key");
  return { key, certificate: own, chain: certificates.filter((cert) => cert !== own) };
}

/**
 * Adds an invisible signature field to `page` with an empty signature of
 * `SIGNATURE_BYTES`. The document must then be saved without object streams
 * and passed to `signSavedPdf`.
 */
export function addSignaturePlaceholder(doc: PDFDocument, page: PDFPage, details: SignatureDetails, name: string): void {
  const { context } = doc;
  const byteRange = PDFArray.withContext(context);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));

  const signature = context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    ByteRange: byteRange,
    Contents: PDFHexString.of("0".repeat(SIGNATURE_BYTES * 2)),
    M: PDFString.fromDate(details.date ?? new Date()),
    Name: PDFHexString.fromText(name),
    ...(details.reason ? { Reason: PDFHexString.fromText(details.reason) } : {}),
    ...(details.location ? { Location: PDFHexString.fromText(details.location) } : {}),
    ...(details.contactInfo ? { ContactInfo: PDFHexString.fromText(details.contactInfo) } : {}),
  });
  const signatureRef = context.register(signature);

  const acroForm = doc.catalog.getOrCreateAcroForm();
  let n = 1;
  const taken = new Set(doc.getForm().getFields().map((field) => field.getName()));
  while (taken.has(`Firma${n}`)) n++;
  const widget = context.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: [0, 0, 0, 0],
    V: signatureRef,
    T: PDFString.of(`Firma${n}`),
    // Print and Locked: an invisible field nobody can move.
    F: 132,
    P: page.ref,
  });
  const widgetRef = context.register(widget);
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(widgetRef);
  else page.node.set(PDFName.of("Annots"), context.obj([widgetRef]));
  acroForm.addField(widgetRef);
  // SignaturesExist | AppendOnly
  acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
}

const latin1 = new TextDecoder("latin1");
const ascii = new TextEncoder();

function indexOf(haystack: Uint8Array, needle: string, from = 0): number {
  const pattern = ascii.encode(needle);
  outer: for (let i = from; i <= haystack.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (haystack[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

/** Signs a document saved with `addSignaturePlaceholder`. Returns the signed bytes. */
export function signSavedPdf(saved: Uint8Array, identity: SigningIdentity, date = new Date()): Uint8Array {
  const bytes = saved.slice();
  const placeholder = `<${"0".repeat(SIGNATURE_BYTES * 2)}>`;
  const contentsStart = indexOf(bytes, placeholder);
  if (contentsStart < 0) throw new Error("No se encontró el espacio para la firma.");
  const contentsEnd = contentsStart + placeholder.length;

  // The ByteRange array of the same dictionary: "[ 0 /********** /********** /********** ]".
  const rangeKey = indexOf(bytes, `/${BYTE_RANGE_PLACEHOLDER}`);
  if (rangeKey < 0) throw new Error("No se encontró el rango de la firma.");
  const open = bytes.lastIndexOf(0x5b, rangeKey);
  const close = bytes.indexOf(0x5d, rangeKey);
  if (open < 0 || close < 0) throw new Error("No se encontró el rango de la firma.");
  const width = close - open + 1;
  const ranges = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
  const written = `[${ranges.join(" ")}]`;
  if (written.length > width) throw new Error("El rango de la firma no cabe.");
  bytes.set(ascii.encode(written.padEnd(width, " ")), open);

  // What is signed: everything but the signature itself.
  const signed = new Uint8Array(ranges[1] + ranges[3]);
  signed.set(bytes.subarray(0, contentsStart), 0);
  signed.set(bytes.subarray(contentsEnd), contentsStart);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signed));
  p7.addCertificate(identity.certificate);
  for (const certificate of identity.chain) p7.addCertificate(certificate);
  p7.addSigner({
    key: identity.key,
    certificate: identity.certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: date as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = forge.util.bytesToHex(der);
  if (hex.length > SIGNATURE_BYTES * 2) throw new Error("La firma no cabe en el espacio reservado.");
  bytes.set(ascii.encode(hex.padEnd(SIGNATURE_BYTES * 2, "0")), contentsStart + 1);
  return bytes;
}

/** For tests: the ByteRange written in a signed file. */
export function readByteRange(bytes: Uint8Array): number[] | null {
  const text = latin1.decode(bytes);
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  return match ? match.slice(1).map(Number) : null;
}
