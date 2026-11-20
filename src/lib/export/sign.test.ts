import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, createVerify } from "node:crypto";
import forge from "node-forge";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  addSignaturePlaceholder,
  CertificateError,
  describeCertificate,
  readByteRange,
  readPkcs12,
  signSavedPdf,
} from "./sign";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

async function signedDocument() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText("Documento firmado", { x: 40, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const identity = readPkcs12(fixture("prueba-rsa.p12"), "secreto");
  addSignaturePlaceholder(doc, page, { reason: "Conforme", location: "Madrid" }, "Prueba ytaPDF");
  const saved = await doc.save({ useObjectStreams: false });
  return { identity, signed: signSavedPdf(saved, identity) };
}

describe("readPkcs12", () => {
  it("opens an RSA certificate and says whose it is", () => {
    const identity = readPkcs12(fixture("prueba-rsa.p12"), "secreto");
    expect(describeCertificate(identity.certificate)).toMatchObject({ name: "Prueba ytaPDF", issuer: "Prueba ytaPDF" });
  });

  it("tells a wrong password from a certificate it cannot use", () => {
    const problem = (bytes: Uint8Array, password: string) => {
      try {
        readPkcs12(bytes, password);
        return null;
      } catch (error) {
        return error instanceof CertificateError ? error.problem : "other";
      }
    };
    expect(problem(fixture("prueba-rsa.p12"), "otra")).toBe("password");
    expect(problem(fixture("prueba-ec.p12"), "secreto")).toBe("unsupported-key");
    expect(problem(new Uint8Array([1, 2, 3]), "secreto")).toBe("format");
  });
});

describe("signSavedPdf", () => {
  it("covers the whole file but the signature, which verifies with the certificate", async () => {
    const { signed } = await signedDocument();
    const range = readByteRange(signed);
    expect(range).not.toBeNull();
    const [start, length1, offset2, length2] = range!;
    expect(start).toBe(0);
    expect(offset2 + length2).toBe(signed.length);

    // The signature sits exactly between the two ranges, as a hex string.
    const padded = new TextDecoder("latin1").decode(signed.subarray(length1 + 1, offset2 - 1));
    let end = padded.length;
    while (end > 0 && padded[end - 1] === "0") end--;
    const hex = padded.slice(0, end);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(hex.length % 2 ? `${hex}0` : hex))) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string };
    };
    const content = Buffer.concat([signed.subarray(0, length1), signed.subarray(offset2)]);
    const digest = createHash("sha256").update(content).digest("binary");

    // The signed attributes carry the document's digest…
    const attributes = p7.rawCapture.authenticatedAttributes;
    const messageDigest = attributes
      .map((attribute) => (attribute.value as forge.asn1.Asn1[]))
      .find((value) => forge.asn1.derToOid(value[0].value as string) === forge.pki.oids.messageDigest);
    const stored = ((messageDigest![1].value as forge.asn1.Asn1[])[0].value as string);
    expect(stored).toBe(digest);

    // …and the signature over those attributes verifies with the certificate.
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attributes);
    const der = Buffer.from(forge.asn1.toDer(set).getBytes(), "binary");
    const certificatePem = forge.pki.certificateToPem(p7.certificates[0]);
    const verifier = createVerify("sha256");
    verifier.update(der);
    expect(verifier.verify(certificatePem, Buffer.from(p7.rawCapture.signature, "binary"))).toBe(true);
  });

  it("leaves a document PDF.js opens, with a signature field", async () => {
    const { signed } = await signedDocument();
    const pdf = await getDocument({ data: signed.slice(), verbosity: 0 }).promise;
    expect(pdf.numPages).toBe(1);
    const annotations = await (await pdf.getPage(1)).getAnnotations();
    const signature = annotations.find((annotation) => annotation.fieldType === "Sig");
    expect(signature).toBeDefined();
  });
});
