// @vitest-environment jsdom
// @vitest-environment-options {"resources": "usable"}
import { Ellipse, FabricObject, Group, IText, Path, Rect } from "fabric";
import { describe, expect, it } from "vitest";
import { createNativeText } from "../nativeText";
import { fabricToDrawables, hasRedactions, redactionAreas, sceneAnnotations } from "./fabricDrawables";

const json = (object: FabricObject) => object.toObject(["ytaKind", "ytaLink", "ytaNative"] as never) as Record<string, unknown>;
const page = (objects: Record<string, unknown>[]) => ({ version: "7", objects });

function pngUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  return canvas.toDataURL();
}

describe("drawables", () => {
  it("turns text, images, paths and shapes into drawables", async () => {
    const text = new IText("hola\nmundo", { fill: "rgba(255, 0, 0, 0.5)", underline: true });
    const noFill = new IText("x", { fill: "" });
    const image = { type: "Image", src: pngUrl(), width: 2, height: 2, left: 10, top: 10 };
    const path = new Path("M 0 0 L 10 10", { stroke: "#00ff00", strokeWidth: 2, fill: "", strokeLineCap: "round", strokeLineJoin: "bevel" });
    const uniform = new Path("M 0 0 L 10 0", { stroke: "#000", strokeWidth: 1, strokeUniform: true, scaleX: 2, strokeLineCap: "square", strokeLineJoin: "round" });
    const plainPath = new Path("M 0 0 L 5 5", { fill: "rgba(0,0,0,0.25)", strokeWidth: 0, strokeLineCap: "butt", strokeLineJoin: "miter" });
    const bare = new Path("M 0 0 L 5 5", { fill: "", stroke: "" });
    const rect = new Rect({ width: 10, height: 20, fill: "transparent", stroke: "#0000ff", strokeWidth: 3, strokeUniform: true, scaleX: 2, scaleY: 3 });
    const ellipse = new Ellipse({ rx: 5, ry: 3, fill: "#123456" });
    const plainRect = new Rect({ width: 4, height: 4, fill: 5 as never, stroke: "rgba(0,0,0,0.5)", strokeWidth: 1 });
    const invisible = new Rect({ width: 4, height: 4, fill: "", strokeWidth: 0 });
    const objects = [text, noFill, image, path, uniform, plainPath, bare, rect, ellipse, plainRect, invisible].map((o) =>
      o instanceof FabricObject ? json(o) : (o as Record<string, unknown>),
    );
    const drawables = await fabricToDrawables(page(objects));
    expect(drawables.map((d) => d.kind)).toEqual(["text", "text", "image", "path", "path", "path", "path", "rect", "ellipse", "rect", "rect"]);
    expect(drawables[10].opacity).toBe(1);
    const [t, empty, img, p, u, pp, b, r, e, pr] = drawables as never as Record<string, unknown>[];
    expect(t).toMatchObject({ color: { r: 1, g: 0, b: 0 }, opacity: 0.5, underline: true, linethrough: false });
    expect((t.lines as unknown[]).length).toBe(2);
    expect(empty).toMatchObject({ color: { r: 0, g: 0, b: 0 }, opacity: 1 });
    expect(img).toMatchObject({ width: 2, height: 2 });
    expect(p).toMatchObject({ lineCap: "round", lineJoin: "bevel", fill: null });
    expect(u).toMatchObject({ lineCap: "square", lineJoin: "round", matrix: [1, 0, 0, 1, 0, 0] });
    expect(pp).toMatchObject({ lineCap: "butt", lineJoin: "miter", stroke: null, opacity: 0.25 });
    expect(b).toMatchObject({ stroke: null, fill: null, opacity: 1 });
    expect(r).toMatchObject({ width: 20, height: 60, fill: null });
    expect(e).toMatchObject({ rx: 5, ry: 3, stroke: null });
    expect(pr).toMatchObject({ fill: null, opacity: 0.5 });
  });

  it("skips hidden objects, notes, links, native text and unknown objects, and enters groups", async () => {
    const hidden = new Rect({ width: 1, height: 1, fill: "#000", visible: false });
    const note = new IText("nota");
    note.set({ ytaKind: "note" } as never);
    const link = new Rect({ width: 1, height: 1 });
    link.set({ ytaKind: "link" } as never);
    const group = new Group([new Rect({ width: 2, height: 2, fill: "#000", opacity: 0.5 })], { opacity: 0.5 });
    const native = createNativeText(
      {
        id: "l",
        kind: "line",
        lines: [[{ text: "a", font: 0, size: 10, color: { space: "gray", components: [0] }, rise: 0, x0: 0, x1: 5 }]],
        joins: [],
        align: "left",
        origin: [0, 0],
        u: [1, 0],
        v: [0, 1],
        hScale: 1,
        width: 5,
        naturalWidth: 5,
        leading: 0,
        size: 10,
        erase: [],
        insertAfter: "end",
        alpha: 1,
        renderMode: 0,
        quads: [],
        editable: true,
        justifyLast: false,
      },
      { fonts: [{ key: "F", name: "F", families: [], bold: false, italic: false, serif: false, monospace: false, sample: "0:0", glyphs: { a: [97, 1, 500] }, space: 250 }], lines: [], paragraphs: [], paragraphOf: [] },
      [1, 0, 0, 1, 0, 0],
    );
    const drawables = await fabricToDrawables(page([...[hidden, note, link, group, native].map(json), { type: "Line", x1: 0, y1: 0, x2: 1, y2: 1 }]));
    expect(drawables).toHaveLength(1);
    expect(drawables[0].opacity).toBeCloseTo(0.25);
    const groupWithoutOpacity = json(new Group([new Rect({ width: 2, height: 2, fill: "#000" })]));
    delete groupWithoutOpacity.opacity;
    expect((await fabricToDrawables(page([groupWithoutOpacity])))[0].opacity).toBe(1);
  });
});

describe("redaction areas", () => {
  it("collects redaction boxes and tells whether they cover other objects", async () => {
    const redact = new Rect({ left: 50, top: 50, width: 20, height: 20, fill: "#000" });
    redact.set({ ytaKind: "redact" } as never);
    const image = new Rect({ left: 50, top: 50, width: 30, height: 30, fill: "#f00", stroke: "#000", strokeWidth: 2 });
    const shape = new Rect({ left: 50, top: 50, width: 30, height: 30, fill: "#f00" });
    shape.set({ ytaKind: "rect" } as never);
    const hidden = new Rect({ width: 1, height: 1, visible: false });
    const plain = await redactionAreas(page([json(shape), json(redact)]));
    expect(plain).toMatchObject({ coversContent: false });
    expect(plain.areas).toHaveLength(1);
    const covering = await redactionAreas(page([json(hidden), json(new Group([image])), json(redact)]));
    expect(covering.coversContent).toBe(true);
    const beside = new Rect({ left: 500, top: 500, width: 5, height: 5, fill: "#f00", stroke: "", strokeWidth: 3 });
    expect((await redactionAreas(page([json(beside), json(redact)]))).coversContent).toBe(false);
  });

  it("finds redactions inside groups", () => {
    expect(hasRedactions(undefined)).toBe(false);
    expect(hasRedactions(page([{ type: "Rect" }]))).toBe(false);
    expect(hasRedactions(page([{ type: "Group", objects: [{ type: "Rect", ytaKind: "redact" }] }]))).toBe(true);
    expect(hasRedactions(page([{ type: "Group", objects: "x" }]))).toBe(false);
  });
});

describe("scene annotations", () => {
  it("reads notes and links, in groups too, with their colours and targets", async () => {
    expect(await sceneAnnotations(page([{ type: "Rect" }, { type: "Group", objects: "x" }]))).toEqual([]);
    const note = new IText("Revisar", { backgroundColor: "#ff0000" });
    note.set({ ytaKind: "note" } as never);
    const link = new Rect({ width: 10, height: 10 });
    link.set({ ytaKind: "link", ytaLink: { url: "https://ejemplo.es" } } as never);
    const bare = new Rect({ width: 10, height: 10 });
    bare.set({ ytaKind: "link" } as never);
    const hidden = new IText("x", { visible: false });
    hidden.set({ ytaKind: "note" } as never);
    const found = await sceneAnnotations(page([json(new Group([note, new Rect()])), json(link), json(bare), json(hidden)]));
    expect(found.map((a) => [a.kind, a.text, a.link?.url ? "url" : null])).toEqual([
      ["note", "Revisar", null],
      ["link", "", "url"],
      ["link", "", null],
    ]);
    expect(found[0].color).toEqual({ r: 1, g: 0, b: 0 });
    expect(found[1].color).toEqual({ r: 1, g: 0.95, b: 0.63 });
  });
});
