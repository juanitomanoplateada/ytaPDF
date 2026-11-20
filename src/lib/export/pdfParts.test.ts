import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, type PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { writeOutline } from "./outline";
import { addPageAnnotations } from "./pdfAnnotations";

describe("page annotations", () => {
  it("adds nothing for empty notes and links that go nowhere", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const added = addPageAnnotations(
      doc,
      page,
      [
        { kind: "note", rect: [0, 0, 10, 10], text: "   ", color: [1, 1, 0] },
        { kind: "link", rect: [0, 0, 10, 10] },
        { kind: "link", rect: [0, 0, 10, 10], pageIndex: 5 },
      ],
      [page],
    );
    expect(added).toBe(0);
    expect(page.node.lookup(PDFName.of("Annots"))).toBeUndefined();
  });

  it("appends to the annotations a page already has", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const existing = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Square" }));
    page.node.set(PDFName.of("Annots"), doc.context.obj([existing]));
    addPageAnnotations(doc, page, [{ kind: "link", rect: [10, 20, 0, 0], url: "https://ejemplo.es/año" }], [page]);
    const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(2);
    const link = annots.lookup(1, PDFDict);
    expect(link.lookup(PDFName.of("A"), PDFDict).get(PDFName.of("URI"))?.toString()).toBe("(https://ejemplo.es/a%C3%B1o)");
  });
});

describe("outline", () => {
  it("writes nothing without entries", async () => {
    const doc = await PDFDocument.create();
    writeOutline(doc, [], []);
    expect(doc.catalog.get(PDFName.of("Outlines"))).toBeUndefined();
  });

  it("links nested entries and keeps an open top as null", async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage(), doc.addPage()];
    writeOutline(doc, pages, [
      {
        title: "Capítulo",
        pageIndex: 0,
        top: null,
        children: [
          { title: "Sección 1", pageIndex: 0, top: 500, children: [] },
          { title: "Sección 2", pageIndex: 1, top: 200, children: [] },
        ],
      },
    ]);
    const root = doc.context.lookup(doc.catalog.get(PDFName.of("Outlines")) as PDFRef, PDFDict);
    const chapter = root.lookup(PDFName.of("First"), PDFDict);
    expect(chapter.lookup(PDFName.of("Dest"), PDFArray).get(3)).toBe(PDFNull);
    expect(chapter.get(PDFName.of("Count"))).toEqual(PDFNumber.of(-2));
    const first = chapter.lookup(PDFName.of("First"), PDFDict);
    const last = chapter.lookup(PDFName.of("Last"), PDFDict);
    expect(first.get(PDFName.of("Next"))).toBe(chapter.get(PDFName.of("Last")));
    expect(last.get(PDFName.of("Prev"))).toBe(chapter.get(PDFName.of("First")));
  });
});
