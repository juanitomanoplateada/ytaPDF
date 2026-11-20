import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { PDFDocument, PDFName, PDFArray } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSignaturePlaceholder,
  CertificateError,
  describeCertificate,
  readByteRange,
  readPkcs12,
  SIGNATURE_BYTES,
  signSavedPdf,
  type SigningIdentity,
} from "./sign";

afterEach(() => vi.restoreAllMocks());

/** An RSA key pair made by Node (forge's own generator is far slower). */
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: forge.pki.publicKeyFromPem(publicKey), privateKey: forge.pki.privateKeyFromPem(privateKey) };
}

const keys = keyPair();
const otherKeys = keyPair();

function certificate(attrs: forge.pki.CertificateField[], publicKey = keys.publicKey): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01");
  cert.validity.notAfter = new Date("2027-01-01");
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return cert;
}

const toBytes = (asn1: forge.asn1.Asn1) => Uint8Array.from(forge.asn1.toDer(asn1).getBytes(), (c) => c.charCodeAt(0));

const pkcs12 = (key: forge.pki.rsa.PrivateKey | null, certs: forge.pki.Certificate[], password: string | null) =>
  toBytes(forge.pkcs12.toPkcs12Asn1(key, certs, password as string, { algorithm: "3des", useMac: password !== null }));

const problemOf = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof CertificateError ? error.problem : String(error);
  }
};

describe("certificate files", () => {
  it("names the holder by organisation, or a dash, when there is no common name", () => {
    const byOrganisation = certificate([{ name: "organizationName", value: "Ayuntamiento" }]);
    expect(describeCertificate(byOrganisation)).toMatchObject({ name: "Ayuntamiento", issuer: "Ayuntamiento" });
    const anonymous = certificate([{ name: "countryName", value: "ES" }]);
    expect(describeCertificate(anonymous)).toMatchObject({ name: "—", issuer: "—" });
  });

  it("reads keys stored without encryption and keeps the other certificates as the chain", () => {
    const own = certificate([{ name: "commonName", value: "Ana" }]);
    const issuer = certificate([{ name: "commonName", value: "Emisor" }], otherKeys.publicKey);
    const identity = readPkcs12(pkcs12(keys.privateKey, [own, issuer], null), "");
    expect(describeCertificate(identity.certificate).name).toBe("Ana");
    expect(identity.chain.map((cert) => describeCertificate(cert).name)).toEqual(["Emisor"]);
  });

  it("needs a private key and a certificate for it", () => {
    const own = certificate([{ name: "commonName", value: "Ana" }]);
    expect(problemOf(() => readPkcs12(pkcs12(null, [own], "clave"), "clave"))).toBe("no-key");
    const foreign = certificate([{ name: "commonName", value: "Otro" }], otherKeys.publicKey);
    expect(problemOf(() => readPkcs12(pkcs12(keys.privateKey, [foreign], "clave"), "clave"))).toBe("no-key");
  });

  it("treats anything thrown that is not an error as a bad format", () => {
    vi.spyOn(forge.pkcs12, "pkcs12FromAsn1").mockImplementation(() => {
      throw "roto";
    });
    const own = certificate([{ name: "commonName", value: "Ana" }]);
    expect(problemOf(() => readPkcs12(pkcs12(keys.privateKey, [own], "clave"), "clave"))).toBe("format");
  });
});

describe("signature placeholder", () => {
  it("joins the annotations the page has and writes only the details given", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.node.set(PDFName.of("Annots"), doc.context.obj([]));
    addSignaturePlaceholder(doc, page, { contactInfo: "ana@correo.es", date: new Date("2026-05-01") }, "Ana");
    const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(1);
    const text = new TextDecoder("latin1").decode(await doc.save({ useObjectStreams: false }));
    expect(text).toContain("/ContactInfo");
    expect(text).not.toContain("/Reason");
    expect(text).not.toContain("/Location");
    expect(text).toContain("D:20260501");
  });

  it("names the field after the signatures the document already has", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    doc.getForm().createTextField("Firma1").addToPage(page, { x: 10, y: 10 });
    addSignaturePlaceholder(doc, page, {}, "Ana");
    expect(doc.getForm().getFields().map((field) => field.getName())).toContain("Firma2");
  });

  it("dates the signature now when no date is given", async () => {
    const doc = await PDFDocument.create();
    addSignaturePlaceholder(doc, doc.addPage(), {}, "Ana");
    const text = new TextDecoder("latin1").decode(await doc.save({ useObjectStreams: false }));
    expect(text).toContain(`D:${new Date().getFullYear()}`);
  });
});

describe("signing saved files", () => {
  const identity = (): SigningIdentity => ({
    key: keys.privateKey,
    certificate: certificate([{ name: "commonName", value: "Ana" }]),
    chain: [],
  });
  const encode = (text: string) => new TextEncoder().encode(text);
  const contents = `<${"0".repeat(SIGNATURE_BYTES * 2)}>`;

  it("needs the reserved space and the byte range", () => {
    expect(() => signSavedPdf(encode("%PDF"), identity())).toThrow("No se encontró el espacio para la firma.");
    expect(() => signSavedPdf(encode(`${contents}`), identity())).toThrow("No se encontró el rango de la firma.");
    expect(() => signSavedPdf(encode(`${contents} /********** ]`), identity())).toThrow("No se encontró el rango de la firma.");
    expect(() => signSavedPdf(encode(`${contents} [ /**********`), identity())).toThrow("No se encontró el rango de la firma.");
    expect(() => signSavedPdf(encode(`[/**********] ${contents}`), identity())).toThrow("El rango de la firma no cabe.");
  });

  it("refuses signatures larger than the reserved space", () => {
    // A chain long enough for the signature to outgrow its space.
    const signer = identity();
    signer.chain = Array.from({ length: 40 }, () => signer.certificate);
    const bytes = encode(`[ 0 /********** /********** /********** ] ${contents}`);
    expect(() => signSavedPdf(bytes, signer)).toThrow("La firma no cabe en el espacio reservado.");
  });

  it("reads no byte range from unsigned files", () => {
    expect(readByteRange(encode("%PDF-1.7"))).toBeNull();
  });
});
