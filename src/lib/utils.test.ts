import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rotateAnnotations } from "./annotationTransforms";
import { COMPRESSION_PRESETS } from "./compression";
import { parseLinkInput } from "./links";
import { describePages, parsePageRanges, rangeErrorText, sanitizeFileName } from "./pageRanges";
import { isProjectFile, ProjectError, readProject, writeProject } from "./project";
import type { SavedSession } from "./session";
import { createZip, readZip } from "./zip";

describe("compression presets", () => {
  it("go from strong to light", () => {
    expect(COMPRESSION_PRESETS.strong.quality).toBeLessThan(COMPRESSION_PRESETS.light.quality);
  });
});

describe("page ranges", () => {
  it("leaves results without an error alone", () => {
    expect(rangeErrorText(parsePageRanges("1", 3))).toBeUndefined();
  });

  it("keeps placeholders it has no value for", () => {
    expect(rangeErrorText({ error: "Falta {nada}" })).toBe("Falta {nada}");
    expect(rangeErrorText({ error: "{page} de {total}", params: { page: 2 } })).toBe("2 de {total}");
  });

  it("speaks of a single page in one-page documents", () => {
    expect(rangeErrorText(parsePageRanges("2", 1))).toBe("La página 2 no existe: el documento tiene 1 página.");
  });

  it("describes no pages as nothing", () => {
    expect(describePages([])).toBe("");
  });

  it("trims dots and spaces from both ends of file names", () => {
    expect(sanitizeFileName(" .. informe final .pdf")).toBe("informe final");
    expect(sanitizeFileName("...")).toBe("");
    expect(sanitizeFileName("a .\t")).toBe("a");
  });
});

describe("link input", () => {
  it("treats an empty destination as no link", () => {
    expect(parseLinkInput("   ")).toEqual({ kind: "url", url: "" });
  });

  it("recognises e-mail addresses only when they have one @ and a dotted host", () => {
    expect(parseLinkInput("ana@correo.es")).toEqual({ kind: "url", url: "mailto:ana@correo.es" });
    expect(parseLinkInput("@correo.es")).toEqual({ kind: "url", url: "https://@correo.es" });
    expect(parseLinkInput("a@b@c.es")).toEqual({ kind: "url", url: "https://a@b@c.es" });
    expect(parseLinkInput("ana@correo.es/x")).toEqual({ kind: "url", url: "https://ana@correo.es/x" });
    expect(parseLinkInput("ana@.es")).toEqual({ kind: "url", url: "https://ana@.es" });
    expect(parseLinkInput("ana@es.")).toEqual({ kind: "invalid" });
  });

  it("rejects words that are not addresses", () => {
    expect(parseLinkInput("hola")).toEqual({ kind: "invalid" });
    expect(parseLinkInput("dos palabras")).toEqual({ kind: "invalid" });
  });

  it("reads page numbers in Spanish and English", () => {
    expect(parseLinkInput("pág. 12")).toEqual({ kind: "page", number: 12 });
    expect(parseLinkInput("Page 3")).toEqual({ kind: "page", number: 3 });
    expect(parseLinkInput("7")).toEqual({ kind: "page", number: 7 });
  });

  it("keeps safe schemes and refuses the rest", () => {
    expect(parseLinkInput("HTTPS://ejemplo.es")).toEqual({ kind: "url", url: "HTTPS://ejemplo.es" });
    expect(parseLinkInput("tel:+34600000000")).toEqual({ kind: "url", url: "tel:+34600000000" });
    expect(parseLinkInput("javascript:alert(1)")).toEqual({ kind: "invalid" });
  });
});

describe("annotation rotation", () => {
  it("places objects without a position or angle as if they were at the origin", () => {
    const rotated = rotateAnnotations({ version: "7", objects: [{ type: "Rect" }] }, 600, 400, 90);
    expect(rotated.objects[0]).toMatchObject({ left: 400, top: 0, angle: 90 });
  });
});

describe("project files", () => {
  const session = (): SavedSession =>
    ({
      name: "Trabajo",
      pages: [],
      annotations: {},
      sources: [{ id: "s1", name: "a.pdf", bytes: new Uint8Array([1, 2, 3]) }],
      images: [
        { url: "blob:png", mime: "image/png", bytes: new Uint8Array([4]) },
        { url: "blob:jpg", mime: "image/jpeg", bytes: new Uint8Array([5]) },
      ],
    }) as unknown as SavedSession;

  it("recognises the extension in any case", () => {
    expect(isProjectFile(new File([], "Trabajo.YTAPDF"))).toBe(true);
    expect(isProjectFile(new File([], "Trabajo.pdf"))).toBe(false);
  });

  it("round-trips sources and images of both kinds", async () => {
    const read = await readProject(writeProject(session()));
    expect(read.sources).toEqual(session().sources);
    expect(read.images.map((image) => image.mime)).toEqual(["image/png", "image/jpeg"]);
  });

  it("drops files the manifest lists but the archive lacks", async () => {
    const files = await readZip(writeProject(session()));
    files.delete("documentos/1.pdf");
    files.delete("imagenes/2.jpg");
    const zip = createZip([...files].map(([name, bytes]) => ({ name, bytes })));
    const read = await readProject(zip);
    expect(read.sources).toEqual([]);
    expect(read.images).toHaveLength(1);
  });

  it("rejects archives that are not projects", async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await expect(readProject(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ProjectError);
    await expect(readProject(createZip([{ name: "otro.txt", bytes: new Uint8Array() }]))).rejects.toBeInstanceOf(ProjectError);
    await expect(readProject(createZip([{ name: "proyecto.json", bytes: encode({ format: "otro", pages: [] }) }]))).rejects.toBeInstanceOf(ProjectError);
    await expect(readProject(createZip([{ name: "proyecto.json", bytes: encode({ format: "ytapdf-proyecto" }) }]))).rejects.toThrow(
      "El archivo no es un proyecto de ytaPDF o está dañado.",
    );
  });
});

/** A one-file ZIP archive written by hand, with the given compression method. */
function handMadeZip(name: string, content: Uint8Array, method: number, comment = ""): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = method === 8 ? deflateRawSync(content) : content;
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, method, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, content.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const commentBytes = new TextEncoder().encode(comment);
  const end = new Uint8Array(22 + commentBytes.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  ev.setUint16(20, commentBytes.length, true);
  end.set(commentBytes, 22);
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

describe("zip archives", () => {
  const content = new TextEncoder().encode("contenido repetido, contenido repetido");

  it("reads deflated entries and finds the directory before a comment", async () => {
    const files = await readZip(handMadeZip("a.txt", content, 8, "un comentario"));
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe("contenido repetido, contenido repetido");
  });

  it("skips entries compressed with methods it cannot read", async () => {
    expect((await readZip(handMadeZip("a.txt", content, 12))).size).toBe(0);
  });

  it("rejects a damaged directory", async () => {
    const zip = handMadeZip("a.txt", content, 0);
    const view = new DataView(zip.buffer);
    view.setUint32(30 + 5 + content.length, 0, true);
    await expect(readZip(zip)).rejects.toThrow("ZIP dañado.");
  });

  it("numbers repeated names, with or without an extension", async () => {
    const empty = new Uint8Array();
    const zip = createZip([
      { name: "../informe", bytes: empty },
      { name: "informe", bytes: empty },
      { name: "./", bytes: empty },
      { name: "", bytes: empty },
      { name: "carpeta\\a.pdf", bytes: empty },
      { name: "carpeta/A.pdf", bytes: empty },
    ]);
    expect([...(await readZip(zip)).keys()]).toEqual([
      "informe",
      "informe (2)",
      "archivo",
      "archivo (2)",
      "carpeta/a.pdf",
      "carpeta/A (2).pdf",
    ]);
  });
});
