import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFormValues,
  applyMetadata,
  assembleDocument,
  flattenForm,
  loadSource,
  stripMetadata,
  type ExportSource,
} from "./assemble";

afterEach(() => vi.restoreAllMocks());

const silenceErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

async function source(id: string, build: (doc: PDFDocument) => void | Promise<void>, pages = 2): Promise<ExportSource> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  await build(doc);
  return { id, bytes: await doc.save(), pageCount: pages };
}

describe("loading sources", () => {
  it("opens files encrypted with an empty password without asking", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.encrypt({ userPassword: "", ownerPassword: "dueño" });
    const loaded = await loadSource({ id: "a", bytes: await doc.save(), pageCount: 1 });
    expect(loaded.getPageCount()).toBe(1);
  });

  it("passes on errors that are not about a missing password", async () => {
    await expect(loadSource({ id: "a", bytes: new TextEncoder().encode("no es un PDF"), pageCount: 1 })).rejects.toThrow();
  });
});

describe("assembling", () => {
  it("needs pages and their sources", async () => {
    await expect(assembleDocument([], new Map())).rejects.toThrow("El documento no tiene páginas.");
    await expect(assembleDocument([{ sourceId: "x", sourceIndex: 0 }], new Map())).rejects.toThrow("Falta el documento de origen.");
  });

  it("builds documents of rasterised pages only", async () => {
    const { doc, pages, inPlace } = await assembleDocument([{ kind: "raster", width: 100, height: 50 }], new Map());
    expect(inPlace).toBe(false);
    expect(pages[0].getSize()).toEqual({ width: 100, height: 50 });
    expect(doc.getTitle()).toBeUndefined();
  });

  it("copies the information of the first source into new documents", async () => {
    const a = await source("a", (doc) => {
      doc.setTitle("Título");
      doc.setAuthor("Ana");
      doc.setSubject("Asunto");
      doc.setKeywords(["clave"]);
    });
    const { doc } = await assembleDocument(
      [
        { sourceId: "a", sourceIndex: 1 },
        { sourceId: "a", sourceIndex: 0 },
      ],
      new Map([["a", a]]),
    );
    expect([doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getKeywords()]).toEqual(["Título", "Ana", "Asunto", "clave"]);
  });
});

describe("form values", () => {
  async function formDoc() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    form.createTextField("nombre").addToPage(page, { x: 10, y: 10 });
    const short = form.createTextField("corto");
    short.setMaxLength(2);
    short.addToPage(page, { x: 10, y: 60 });
    form.createCheckBox("acepto").addToPage(page, { x: 10, y: 110 });
    const radio = form.createRadioGroup("color");
    radio.addOptionToPage("rojo", page, { x: 10, y: 160 });
    radio.addOptionToPage("azul", page, { x: 40, y: 160 });
    const list = form.createDropdown("pais");
    list.addOptions(["ES", "PT"]);
    list.addToPage(page, { x: 10, y: 210 });
    const options = form.createOptionList("idiomas");
    options.addOptions(["es", "en", "fr"]);
    options.enableMultiselect();
    options.addToPage(page, { x: 10, y: 260 });
    form.createButton("enviar").addToPage("Enviar", page, { x: 10, y: 310 });
    return { doc, form };
  }

  it("writes every kind of field and reports the ones that fail", async () => {
    const errors = silenceErrors();
    const { doc, form } = await formDoc();
    const failed = await applyFormValues(doc, {
      nombre: 5 as never,
      corto: "demasiado largo",
      acepto: false,
      color: "azul",
      pais: "PT",
      idiomas: ["es", "fr"],
      enviar: "x",
      falta: "x",
    });
    expect(failed).toEqual(["corto"]);
    expect(form.getTextField("nombre").getText() ?? "").toBe("");
    expect(form.getCheckBox("acepto").isChecked()).toBe(false);
    expect(form.getRadioGroup("color").getSelected()).toBe("azul");
    expect(form.getDropdown("pais").getSelected()).toEqual(["PT"]);
    expect(form.getOptionList("idiomas").getSelected()).toEqual(["es", "fr"]);
    expect(errors).toHaveBeenCalled();
  });

  it("clears choices without a value", async () => {
    const { doc, form } = await formDoc();
    await applyFormValues(doc, { color: "azul", pais: "ES", idiomas: ["en"] });
    await applyFormValues(doc, { color: "", pais: false, idiomas: "en" });
    expect(form.getRadioGroup("color").getSelected()).toBeUndefined();
    expect(form.getDropdown("pais").getSelected()).toEqual([]);
    expect(form.getOptionList("idiomas").getSelected()).toEqual(["en"]);
  });

  it("uses the Unicode font only when a value needs it, and survives appearances that fail", async () => {
    const errors = silenceErrors();
    const { doc, form } = await formDoc();
    const fieldFont = vi.fn(async (target: PDFDocument) => target.embedFont(StandardFonts.Helvetica));
    await applyFormValues(doc, { nombre: "Ana" }, fieldFont);
    expect(fieldFont).not.toHaveBeenCalled();
    vi.spyOn(form, "updateFieldAppearances").mockImplementation(() => {
      throw new Error("sin glifos");
    });
    await applyFormValues(doc, { nombre: "Анна" }, fieldFont);
    expect(fieldFont).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("No se pudo actualizar la apariencia de los campos:", expect.anything());
  });

  it("brings the fields of copied pages along, up to their top-level field", async () => {
    const withForm = await source(
      "f",
      (doc) => {
        const { context } = doc;
        const page = doc.getPage(0);
        doc.getForm().createTextField("campo").addToPage(page, { x: 10, y: 10 });
        const parent = context.register(context.obj({ T: PDFString.of("padre"), FT: "Tx" }));
        const child = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 5, 5], Parent: parent }));
        const orphan = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 5, 5], Parent: context.nextRef() }));
        const nameless = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 5, 5] }));
        const link = context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5] }));
        page.node.Annots()!.push(child);
        page.node.Annots()!.push(orphan);
        page.node.Annots()!.push(nameless);
        page.node.Annots()!.push(link);
        page.node.Annots()!.push(context.obj(3));
        const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
        acroForm.set(PDFName.of("Q"), context.obj(1));
      },
    );
    const plain = await source("p", () => {}, 1);
    const { doc } = await assembleDocument(
      [
        { sourceId: "p", sourceIndex: 0 },
        { sourceId: "f", sourceIndex: 0 },
      ],
      new Map([
        ["f", withForm],
        ["p", plain],
      ]),
    );
    const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    expect(acroForm.lookup(PDFName.of("Fields"))?.toString().match(/ R/g)).toHaveLength(2);
    expect(acroForm.get(PDFName.of("Q"))?.toString()).toBe("1");
    expect(acroForm.has(PDFName.of("NeedAppearances"))).toBe(false);
  });

  it("lists the fields of sources that have widgets but no form of their own", async () => {
    const loose = await source("l", (doc) => {
      const { context } = doc;
      const widget = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 5, 5], T: PDFString.of("suelto"), FT: "Tx" }));
      doc.getPage(0).node.set(PDFName.of("Annots"), context.obj([widget]));
    });
    const { doc } = await assembleDocument(
      [
        { sourceId: "l", sourceIndex: 1 },
        { sourceId: "l", sourceIndex: 0 },
      ],
      new Map([["l", loose]]),
    );
    const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    expect(acroForm.has(PDFName.of("DA"))).toBe(false);
  });

  it("adds no form when no copied page has fields", async () => {
    const plain = await source("p", () => {}, 2);
    const { doc } = await assembleDocument(
      [
        { sourceId: "p", sourceIndex: 1 },
        { sourceId: "p", sourceIndex: 0 },
      ],
      new Map([["p", plain]]),
    );
    expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
  });
});

describe("document metadata", () => {
  it("writes author and keywords, removes what is empty and drops XMP", async () => {
    const doc = await PDFDocument.create();
    doc.setSubject("Viejo");
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(doc.context.stream("<x/>")));
    applyMetadata(doc, { title: "", author: " Ana ", subject: "", keywords: "uno, dos" });
    expect(doc.getAuthor()).toBe("Ana");
    expect(doc.getKeywords()).toBe("uno, dos");
    expect(doc.getSubject()).toBeUndefined();
    expect(doc.catalog.has(PDFName.of("Metadata"))).toBe(false);
  });

  it("copes with documents without an information dictionary", async () => {
    const doc = await PDFDocument.create();
    doc.context.trailerInfo.Info = undefined;
    doc.catalog.set(PDFName.of("Metadata"), doc.context.obj({}));
    expect(() => applyMetadata(doc, { title: "", author: "", subject: "", keywords: "" })).not.toThrow();
    stripMetadata(doc);
    expect(doc.context.trailerInfo.Info).toBeUndefined();
  });

  it("strips an inline information dictionary too", async () => {
    const doc = await PDFDocument.create();
    doc.context.trailerInfo.Info = doc.context.obj({ Title: PDFString.of("x") });
    stripMetadata(doc);
    expect(doc.context.trailerInfo.Info).toBeUndefined();
  });
});

describe("flattening forms", () => {
  it("leaves documents without a form or without fields alone", async () => {
    const doc = await PDFDocument.create();
    flattenForm(doc);
    expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
    doc.catalog.set(PDFName.of("AcroForm"), doc.context.register(doc.context.obj({ Fields: [] })));
    flattenForm(doc);
    expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
  });

  it("flattens what fields show when their appearance cannot be rebuilt", async () => {
    const errors = silenceErrors();
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const form = doc.getForm();
    form.createTextField("nombre").addToPage(page, { x: 10, y: 10 });
    const flatten = form.flatten.bind(form);
    const spy = vi.spyOn(form, "flatten").mockImplementationOnce(() => {
      throw new Error("sin glifos");
    });
    spy.mockImplementation(flatten);
    flattenForm(doc);
    expect(spy).toHaveBeenLastCalledWith({ updateFieldAppearances: false });
    expect(errors).toHaveBeenCalledWith("No se pudieron regenerar todos los campos al aplanar:", expect.anything());
    expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
  });
});
