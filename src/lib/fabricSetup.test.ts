// @vitest-environment jsdom
// @vitest-environment-options {"resources": "usable"}
import { ActiveSelection, Canvas, Ellipse, FabricImage, FabricObject, Group, IText, Path, Rect, Textbox, type TPointerEvent } from "fabric";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alignObjects,
  applyShapeStyle,
  applyTextStyle,
  arrange,
  arrowPath,
  bakeScale,
  clearTopLayer,
  createImage,
  createMark,
  createShape,
  createSignature,
  createText,
  describeSelection,
  distributeObjects,
  drawShapePreview,
  editableSelection,
  groupSelected,
  installAlignmentGuides,
  isLocked,
  isText,
  kindOf,
  linkOf,
  markInk,
  pasteObjects,
  prepareObject,
  removeObjects,
  selectedObjects,
  selectionText,
  serializeSelection,
  setLinkTarget,
  setLocked,
  setObjectBounds,
  syncSelectionLock,
  ungroupSelected,
} from "./fabricSetup";
import { i18n } from "./i18n.svelte";
import { createNativeText } from "./nativeText";
import type { ShapeStyle, TextStyle } from "./editor.svelte";

const STYLE: ShapeStyle = { stroke: "#d32f2f", fill: null, strokeWidth: 3 };
const TEXT: TextStyle = {
  fontFamily: "Helvetica, Arial, sans-serif",
  fontSize: 16,
  fill: "#000000",
  fontWeight: "normal",
  fontStyle: "normal",
  underline: false,
  linethrough: false,
  textAlign: "left",
  lineHeight: 1.16,
};

let canvas: Canvas;
beforeEach(() => {
  i18n.set("es");
  canvas = new Canvas(document.createElement("canvas"), { width: 600, height: 800 });
});
afterEach(() => {
  // A render still scheduled for the next frame would run on a disposed canvas.
  canvas.discardActiveObject();
  canvas.cancelRequestedRender();
  // Not awaited: in jsdom the promise can wait for a frame that never comes.
  void canvas.dispose();
  vi.restoreAllMocks();
});

const rect = (left: number, top: number, extra: Record<string, unknown> = {}) => new Rect({ left, top, width: 20, height: 20, fill: "#ff0000", ...extra });
const select = (...objects: FabricObject[]) => {
  for (const object of objects) if (!canvas.getObjects().includes(object)) canvas.add(object);
  canvas.setActiveObject(objects.length === 1 ? objects[0] : new ActiveSelection(objects, { canvas }));
};

function native() {
  const color = { space: "gray" as const, components: [0] };
  return createNativeText(
    {
      id: "l:1",
      kind: "line",
      lines: [[..."ab"].map((c, i) => ({ text: c, font: 0, size: 10, color, rise: 0, x0: i * 5, x1: i * 5 + 5 }))],
      joins: [],
      align: "left",
      origin: [100, 700],
      u: [1, 0],
      v: [0, 1],
      hScale: 1,
      width: 10,
      naturalWidth: 10,
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
    {
      fonts: [{ key: "F", name: "Prueba", families: ["Prueba"], bold: false, italic: false, serif: false, monospace: false, sample: "0:0", glyphs: { a: [97, 1, 500], b: [98, 1, 500] }, space: 250 }],
      lines: [],
      paragraphs: [],
      paragraphOf: [],
    },
    [1, 0, 0, -1, 0, 800],
  );
}

describe("kinds and locking", () => {
  it("names objects by their kind", async () => {
    const image = new FabricImage(document.createElement("canvas"));
    expect([new Group([]), new IText("a"), image, new Ellipse(), new Rect(), new Path("M 0 0"), new FabricObject()].map(kindOf)).toEqual([
      "group",
      "text",
      "image",
      "ellipse",
      "rect",
      "signature",
      "image",
    ]);
    const tagged = new Rect();
    tagged.set({ ytaKind: "redact" } as never);
    expect(kindOf(tagged)).toBe("redact");
    expect(isText(new IText("a"))).toBe(true);
    expect(isText(null)).toBe(false);
  });

  it("locks objects against moving and editing, and selections that hold one", () => {
    const text = new IText("hola");
    setLocked(text, true);
    expect([isLocked(text), text.editable, text.lockMovementX, text.hasControls]).toEqual([true, false, true, false]);
    setLocked(text, false);
    expect(text.editable).toBe(true);
    const shape = rect(0, 0);
    shape.set({ locked: true } as never);
    expect(prepareObject(shape).lockMovementX).toBe(true);
    expect(prepareObject(rect(0, 0)).lockMovementX).toBe(false);

    select(shape, rect(50, 50));
    syncSelectionLock(canvas);
    expect(canvas.getActiveObject()!.lockMovementX).toBe(true);
    canvas.setActiveObject(rect(100, 100));
    expect(() => syncSelectionLock(canvas)).not.toThrow();
  });
});

describe("factories", () => {
  it("creates text, signatures, marks and ink", async () => {
    expect(createText("hola", { ...TEXT, lineHeight: 0 }).lineHeight).toBe(1.16);
    expect(createText("hola", TEXT).lineHeight).toBe(1.16);
    const drawn = createSignature({ path: "M 0 0 L 100 50", width: 100, height: 50, color: "#000", strokeWidth: 2 }, 50);
    expect(drawn).toMatchObject({ fill: null, stroke: "#000", strokeLineCap: "round" });
    expect(drawn.scaleX).toBeCloseTo(0.5);
    const typed = createSignature({ path: "M 0 0 L 0 0", width: 0, height: 0, color: "#123", strokeWidth: 0, filled: true }, 50);
    expect(typed).toMatchObject({ fill: "#123", strokeWidth: 0 });
    expect(kindOf(createMark("cross", 24, "#0f0"))).toBe("mark");
    const ink = new Path("M 0 0 L 5 5");
    markInk(ink);
    expect(kindOf(ink)).toBe("ink");
  });

  it("loads images scaled to fit", async () => {
    const source = document.createElement("canvas");
    source.width = 200;
    source.height = 100;
    const image = await createImage(source.toDataURL(), 100, 1000);
    expect(image.scaleX).toBeCloseTo(0.5);
    const small = await createImage(source.toDataURL(), 1000, 1000);
    expect(small.scaleX).toBe(1);
  });

  it("builds every drawing tool's object", () => {
    const start = { x: 10, y: 10 };
    const end = { x: 110, y: 60 };
    const kinds = (["rect", "ellipse", "line", "arrow", "highlight", "redact", "note", "link"] as const).map((tool) => {
      const object = createShape(tool, start, end, { ...STYLE, fill: "#00ff00" }, "#ffee00");
      return [kindOf(object), object.constructor.name];
    });
    expect(kinds.map(([kind]) => kind)).toEqual(["rect", "ellipse", "line", "arrow", "highlight", "redact", "note", "link"]);
    expect(createShape("note", start, end, STYLE, "#fff")).toBeInstanceOf(Textbox);
    expect(linkOf(createShape("link", start, end, STYLE, "#fff"))).toEqual({ url: "" });
    expect(arrowPath(0, 0, 10, 0, 1)).toMatch(/^M 0 0 L 10 0 M/);
  });
});

describe("scaling", () => {
  it("turns scale into size for text, ellipses and rectangles", () => {
    expect(bakeScale(undefined)).toBe(false);
    expect(bakeScale(new Group([rect(0, 0)], { scaleX: 2 }))).toBe(false);
    expect(bakeScale(rect(0, 0))).toBe(false);
    const text = new IText("a", { fontSize: 10, scaleX: 2, scaleY: 2 });
    expect(bakeScale(text)).toBe(true);
    expect(text.fontSize).toBe(20);
    const ellipse = new Ellipse({ rx: 5, ry: 5, scaleX: 2, scaleY: 1 });
    bakeScale(ellipse);
    expect([ellipse.rx, ellipse.scaleX]).toEqual([10, 1]);
    const box = rect(0, 0, { scaleY: 3 });
    bakeScale(box);
    expect(box.height).toBe(60);
    expect(bakeScale(new Path("M 0 0 L 1 1", { scaleX: 2 }))).toBe(false);
    const line = native();
    line.set({ scaleY: 2 });
    expect(bakeScale(line)).toBe(true);
  });
});

describe("describing the selection", () => {
  it("is empty without a selection", () => {
    expect(describeSelection(canvas)).toBeNull();
    expect(selectedObjects(canvas)).toEqual([]);
  });

  it("reports text, shape, highlight, stacking, size and link of the selection", () => {
    const text = new IText("hola", { fill: "#ABC", fontWeight: 700, fontStyle: "italic", underline: true, textAlign: "justify", scaleY: 2, fontSize: 10, angle: 30, flipX: true });
    Object.assign(text, { lineHeight: 0 });
    canvas.add(rect(300, 300), text);
    select(text);
    expect(describeSelection(canvas)).toMatchObject({
      kind: "text",
      count: 1,
      angle: 30,
      flipX: true,
      text: { fill: "#aabbcc", fontWeight: "bold", fontStyle: "italic", underline: true, textAlign: "left", fontSize: 20, lineHeight: 1.16 },
      canRaise: false,
      canLower: true,
      size: { width: expect.any(Number), height: expect.any(Number) },
      link: null,
      canGroup: false,
    });

    const gradient = new IText("x", { fill: { type: "linear" } as never });
    const highlight = createShape("highlight", { x: 0, y: 0 }, { x: 10, y: 10 }, STYLE, "#FFEE00");
    const shape = rect(10, 10, { stroke: "#00F", fill: "" });
    const sig = createSignature({ path: "M 0 0 L 5 5", width: 5, height: 5, color: "#222222", strokeWidth: 0, filled: true }, 10);
    select(gradient, highlight, shape, sig);
    const info = describeSelection(canvas)!;
    expect(info).toMatchObject({ kind: "multiple", count: 4, size: null, canGroup: true, highlight: "#ffee00" });
    expect(info.text?.fill).toBe("#000000");
    expect(info.shape).toEqual({ stroke: "#0000ff", fill: null, strokeWidth: 1 });

    select(sig);
    expect(describeSelection(canvas)!.shape).toEqual({ stroke: "#222222", fill: null, strokeWidth: 0 });
    // Paths with an empty fill, or with a stroke as well, are read by their stroke.
    const unfilled = new Path("M 0 0 L 5 5", { fill: "", stroke: "#333333", strokeWidth: 2 });
    select(unfilled);
    expect(describeSelection(canvas)!.shape).toEqual({ stroke: "#333333", fill: null, strokeWidth: 2 });
    const both = new Path("M 0 0 L 5 5", { fill: "#111111", stroke: "#444444", strokeWidth: 2 });
    select(both);
    expect(describeSelection(canvas)!.shape).toEqual({ stroke: "#444444", fill: "#111111", strokeWidth: 2 });
    const odd = rect(0, 0, { stroke: { type: "pattern" }, fill: "rgb(1,2,3)", ytaKind: "rect" });
    select(odd);
    expect(describeSelection(canvas)!.shape).toEqual({ stroke: "#000000", fill: "rgb(1,2,3)", strokeWidth: 1 });
    const patterned = createShape("highlight", { x: 0, y: 0 }, { x: 1, y: 1 }, STYLE, "#fff");
    patterned.set("fill", { type: "pattern" } as never);
    select(patterned);
    expect(describeSelection(canvas)!.highlight).toBeNull();
  });

  it("lists the original fonts and substitutions of document text, and links", () => {
    const line = native();
    line.set("text", "abZ");
    select(line);
    const info = describeSelection(canvas)!;
    expect(info.native).toBe(true);
    expect(info.originalFonts).toEqual([{ label: "Prueba", css: line.ytaNative.fonts[0].css }]);
    expect(info.substituted).toEqual(["Z"]);
    line.ytaNative.fonts[0].css = "yta-f0, Arial";
    expect(describeSelection(canvas)!.originalFonts[0].label).toBe("Prueba");

    const link = createShape("link", { x: 0, y: 0 }, { x: 10, y: 10 }, STYLE, "#fff");
    link.set({ ytaLink: { pageId: "p2" } } as never);
    select(link);
    expect(describeSelection(canvas)!.link).toEqual({ pageId: "p2" });
    link.set({ ytaLink: {} } as never);
    expect(linkOf(link)).toEqual({ url: "" });
  });
});

describe("links", () => {
  it("points the selected, unlocked links somewhere else", () => {
    const link = createShape("link", { x: 0, y: 0 }, { x: 10, y: 10 }, STYLE, "#fff");
    const locked = createShape("link", { x: 20, y: 0 }, { x: 30, y: 10 }, STYLE, "#fff");
    setLocked(locked, true);
    select(link, locked, rect(50, 50));
    expect(setLinkTarget(canvas, { url: "https://ejemplo.es" })).toBe(true);
    expect(linkOf(link)).toEqual({ url: "https://ejemplo.es" });
    expect(linkOf(locked)).toEqual({ url: "" });
    select(rect(80, 80));
    expect(setLinkTarget(canvas, { url: "x" })).toBe(false);
  });
});

describe("alignment, grouping and bounds", () => {
  it("aligns one object to the page and several to each other", () => {
    const a = rect(100, 100);
    expect(alignObjects(canvas, "left", { width: 600, height: 800 })).toBe(false);
    select(a);
    alignObjects(canvas, "left", { width: 600, height: 800 });
    expect(a.getBoundingRect().left).toBeCloseTo(0);
    const b = rect(300, 300);
    select(a, b);
    alignObjects(canvas, "top", { width: 600, height: 800 });
    expect(b.getBoundingRect().top).toBeCloseTo(a.getBoundingRect().top);
  });

  it("distributes three or more objects", () => {
    const [a, b, c] = [rect(0, 0), rect(50, 0), rect(300, 0)];
    select(a, b);
    expect(distributeObjects(canvas, "horizontal")).toBe(false);
    select(a, b, c);
    expect(distributeObjects(canvas, "horizontal")).toBe(true);
    // Boxes include the 1-unit stroke: equal gaps put the middle one here.
    expect(b.getBoundingRect().left).toBeCloseTo(139.5);
  });

  it("groups and ungroups, refusing document text and locked objects", () => {
    const [a, b] = [rect(0, 0), rect(50, 50)];
    select(a);
    expect(groupSelected(canvas)).toBeNull();
    select(a, b);
    const group = groupSelected(canvas)!;
    expect(canvas.getObjects()).toEqual([group]);
    expect(ungroupSelected(canvas)).toHaveLength(2);
    select(canvas.getObjects()[0]);
    expect(ungroupSelected(canvas)).toEqual([]);
    const single = new Group([rect(0, 0)]);
    select(single);
    expect(ungroupSelected(canvas)).toHaveLength(1);
    const locked = new Group([rect(0, 0), rect(10, 10)]);
    setLocked(locked, true);
    select(locked);
    expect(ungroupSelected(canvas)).toEqual([]);
    select(rect(0, 0), native());
    expect(groupSelected(canvas)).toBeNull();
  });

  it("moves and resizes the selection to exact bounds", () => {
    expect(setObjectBounds(canvas, { left: 10 }, false)).toBe(false);
    const box = rect(100, 100, { strokeWidth: 0 });
    select(box);
    setObjectBounds(canvas, { left: 10, top: 20 }, false);
    expect(box.getBoundingRect()).toMatchObject({ left: 10, top: 20 });
    setObjectBounds(canvas, { width: 40 }, false);
    expect(box.width).toBeCloseTo(40);
    setObjectBounds(canvas, { height: 10 }, true);
    expect(box.width).toBeCloseTo(20);
    setObjectBounds(canvas, { left: 30 }, false);
    setObjectBounds(canvas, { top: 30 }, false);
    setObjectBounds(canvas, { width: 0 }, false);
    expect(box.width).toBeCloseTo(20);
    const text = new IText("hola", { fontSize: 10 });
    select(text);
    setObjectBounds(canvas, { height: text.getScaledHeight() * 2 }, false);
    expect(text.fontSize).toBe(20);
    setObjectBounds(canvas, { width: text.getScaledWidth() / 2 }, false);
    expect(text.fontSize).toBe(10);
    const empty = new Rect({ width: 0, height: 0 });
    select(empty);
    setObjectBounds(canvas, { width: 10, height: 10 }, false);
    select(rect(0, 0), rect(50, 50));
    setObjectBounds(canvas, { width: 200 }, false);
    const locked = rect(0, 0);
    setLocked(locked, true);
    select(locked);
    expect(setObjectBounds(canvas, { left: 1 }, false)).toBe(false);
  });
});

describe("styles", () => {
  it("styles plain text, clearing per-character styles, and document text per character", () => {
    expect(applyTextStyle(canvas, { fontSize: 20 })).toBe(false);
    const text = new IText("hola", { scaleY: 2, styles: { 0: { 0: { fill: "red" } } } as never });
    const line = native();
    const locked = new IText("fijo");
    setLocked(locked, true);
    select(text, line, locked);
    expect(applyTextStyle(canvas, { fontSize: 20, fill: "#00ff00", textAlign: "center" })).toBe(true);
    expect(text.fontSize).toBe(10);
    expect(text.styles).toEqual({});
    expect(line.textAlign).toBe("left");
    expect(line.getSelectionStyles(0, 1)[0]).toMatchObject({ fill: "#00ff00", fontSize: 20 });
    expect(locked.fill).not.toBe("#00ff00");
    // Settings only plain text takes leave document text alone.
    select(line);
    applyTextStyle(canvas, { textAlign: "right" });
    expect(line.textAlign).toBe("left");
    applyTextStyle(canvas, { fill: "#123456" });
    expect(line.getSelectionStyles(0, 1)[0]).toMatchObject({ fill: "#123456" });
    const plain = new IText("a");
    select(plain);
    applyTextStyle(canvas, { underline: true });
    expect(plain.underline).toBe(true);
  });

  it("styles shapes, highlights and signatures", () => {
    const shape = rect(0, 0, { ytaKind: "rect" });
    const ellipse = new Ellipse({ rx: 5, ry: 5 });
    const line = createShape("line", { x: 0, y: 0 }, { x: 10, y: 10 }, STYLE, "#fff");
    const highlight = createShape("highlight", { x: 0, y: 0 }, { x: 10, y: 10 }, STYLE, "#fff");
    const typed = createSignature({ path: "M 0 0 L 5 5", width: 5, height: 5, color: "#222", strokeWidth: 0, filled: true }, 10);
    const text = new IText("x");
    select(shape, ellipse, line, highlight, typed, text);
    expect(applyShapeStyle(canvas, { stroke: "#00f", strokeWidth: 5, fill: "#0f0" }, "#ff0")).toBe(true);
    expect([shape.fill, ellipse.fill, line.fill, line.strokeWidth, highlight.fill, typed.fill]).toEqual(["#0f0", "#0f0", null, 5, "#ff0", "#00f"]);
    applyShapeStyle(canvas, { strokeWidth: 1 });
    expect(typed.fill).toBe("#00f");
    expect(highlight.fill).toBe("#ff0");
    select(shape);
    applyShapeStyle(canvas, { stroke: "#abcdef" });
    expect([shape.stroke, shape.strokeWidth]).toEqual(["#abcdef", 1]);
    select(text);
    expect(applyShapeStyle(canvas, { stroke: "#000" })).toBe(false);
  });
});

describe("stacking", () => {
  it("moves the selection to the front, back, forward and backward", () => {
    const [a, b, c] = [rect(0, 0), rect(5, 5), rect(10, 10)];
    canvas.add(a, b, c);
    select(a);
    expect(arrange(canvas, "front")).toBe(true);
    expect(canvas.getObjects().at(-1)).toBe(a);
    expect(arrange(canvas, "front")).toBe(false);
    expect(arrange(canvas, "back")).toBe(true);
    expect(canvas.getObjects()[0]).toBe(a);
    expect(arrange(canvas, "back")).toBe(false);
    expect(arrange(canvas, "backward")).toBe(false);
    expect(arrange(canvas, "forward")).toBe(true);
    expect(arrange(canvas, "backward")).toBe(true);
    expect(canvas.getObjects()[0]).toBe(a);
    select(c);
    expect(arrange(canvas, "forward")).toBe(false);
    // Several objects keep their order among themselves.
    select(c, b);
    expect(arrange(canvas, "front")).toBe(true);
    expect(canvas.getObjects().slice(-2)).toEqual([b, c]);
  });
});

describe("copy and paste", () => {
  it("serialises the selection in page coordinates, document text as plain text", () => {
    const text = new IText("hola", { left: 10, top: 10 });
    const line = native();
    select(line, text);
    const data = serializeSelection(canvas);
    expect(data.map((o) => o.type)).toEqual(["IText", "IText"]);
    expect(selectionText(canvas)).toBe("ab\nhola");
  });

  it("pastes one or several objects, unlocked and shifted", async () => {
    const locked = rect(10, 10);
    setLocked(locked, true);
    const [one] = await pasteObjects(canvas, [locked.toObject(["locked"] as never) as unknown as Record<string, unknown>], 5);
    expect(one.left).toBe(15);
    expect(isLocked(one)).toBe(false);
    expect(canvas.getActiveObject()).toBe(one);
    const many = await pasteObjects(canvas, [rect(0, 0).toObject() as unknown as Record<string, unknown>, rect(5, 5).toObject() as unknown as Record<string, unknown>], 0);
    expect(canvas.getActiveObject()).toBeInstanceOf(ActiveSelection);
    expect(many).toHaveLength(2);
    expect(await pasteObjects(canvas, [], 0)).toEqual([]);
  });
});

describe("removing", () => {
  it("removes objects but only marks document text as deleted", () => {
    const shape = rect(0, 0);
    const line = native();
    canvas.add(shape, line);
    const modified = vi.fn();
    canvas.on("object:modified", modified);
    removeObjects(canvas, [shape, line]);
    expect(canvas.getObjects()).toEqual([line]);
    expect(line.visible).toBe(false);
    expect(modified).toHaveBeenCalled();
    removeObjects(canvas, [line]);
  });

  it("removes the selection with the delete control, sparing locked objects", () => {
    const [a, b] = [rect(0, 0), rect(50, 50)];
    setLocked(b, true);
    select(a, b);
    const active = canvas.getActiveObject()!;
    const control = active.controls.deleteControl;
    expect(control.mouseUpHandler!({} as TPointerEvent, { target: active } as never, 0, 0)).toBe(true);
    expect(canvas.getObjects()).toEqual([b]);
    expect(control.mouseUpHandler!({} as TPointerEvent, { target: rect(0, 0) } as never, 0, 0)).toBe(false);
    select(b);
    canvas.getActiveObject()!.controls.deleteControl.mouseUpHandler!({} as TPointerEvent, { target: b } as never, 0, 0);
    expect(canvas.getObjects()).toEqual([b]);
  });

  it("draws the delete icon at the object's angle", () => {
    const shape = rect(100, 100, { angle: 45 });
    select(shape);
    canvas.renderAll();
    const ctx = canvas.getContext();
    const rotate = vi.spyOn(ctx, "rotate");
    shape.controls.deleteControl.render(ctx, 10, 10, {}, shape);
    rect(0, 0).controls.deleteControl.render(ctx, 10, 10, {}, rect(0, 0));
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it("gives text its corner handles only and paragraphs their sides", () => {
    expect(Object.keys(new IText("a").controls)).not.toContain("ml");
    expect(Object.keys(new Textbox("a").controls)).toContain("ml");
    expect(Object.keys(new Textbox("a").controls)).not.toContain("mt");
    expect(editableSelection(canvas)).toEqual([]);
  });
});

describe("guides and previews", () => {
  it("snaps moving objects to the page and other objects, drawing and clearing the guides", () => {
    const uninstall = installAlignmentGuides(canvas, () => ({ width: 600, height: 800 }));
    const other = rect(200, 200);
    const hidden = rect(400, 400, { visible: false });
    const moving = rect(202, 400);
    canvas.add(other, hidden, moving);
    const clear = vi.spyOn(canvas, "clearContext");
    canvas.fire("object:moving", { target: moving, e: { altKey: false } } as never);
    expect(moving.left).toBe(200);
    canvas.renderAll();
    expect(clear).toHaveBeenCalled();
    canvas.fire("mouse:up", {} as never);
    canvas.fire("mouse:up", {} as never);

    // Alt moves freely; far from anything nothing snaps.
    moving.set({ left: 203 });
    canvas.fire("object:moving", { target: moving, e: { altKey: true } } as never);
    expect(moving.left).toBe(203);
    canvas.renderAll();
    const far = rect(523, 377);
    canvas.add(far);
    canvas.fire("object:moving", { target: far, e: {} } as never);
    expect(far.left).toBe(523);
    const vertical = rect(450, 211);
    canvas.add(vertical);
    canvas.fire("object:moving", { target: vertical, e: {} } as never);
    expect(vertical.top).toBe(210.5);
    select(moving, other);
    canvas.fire("object:moving", { target: canvas.getActiveObject(), e: {} } as never);
    canvas.fire("object:moving", { target: undefined, e: {} } as never);
    uninstall();
  });

  it("previews every drawing tool on the top layer", () => {
    const ctx = canvas.contextTop;
    const stroke = vi.spyOn(ctx, "stroke");
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(readonly d: string) {}
      },
    );
    for (const tool of ["highlight", "redact", "note", "link", "rect", "ellipse", "line", "arrow"] as const) {
      drawShapePreview(canvas, tool, { x: 0, y: 0 }, { x: 50, y: 20 }, STYLE, "#ff0");
    }
    drawShapePreview(canvas, "rect", { x: 0, y: 0 }, { x: 50, y: 20 }, { ...STYLE, fill: "#00f" }, "#ff0");
    clearTopLayer(canvas);
    expect(stroke).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
