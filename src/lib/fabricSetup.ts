import {
  ActiveSelection,
  BaseFabricObject,
  Control,
  controlsUtils,
  Ellipse,
  FabricImage,
  FabricObject,
  FabricText,
  IText,
  InteractiveFabricObject,
  Path,
  Rect,
  Textbox,
  util,
  type Canvas,
  type TPointerEvent,
  type Transform,
} from "fabric";
import { isBoldWeight, isItalicStyle } from "./fonts";
import { bakeNativeScale, isNative, markDeleted, originalFontLabel, substitutedChars, toPlainTextData } from "./nativeText";
import type {
  ArrangeAction,
  DrawTool,
  ObjectKind,
  SelectionInfo,
  ShapeStyle,
  SignatureData,
  TextStyle,
} from "./editor.svelte";

const ACCENT = "#1976d2";
const DANGER = "#e5484d";

// ── Global look & controls (applied once, before any object is created) ────

// Extra properties every object carries through serialisation, undo and copy.
BaseFabricObject.customProperties.push("ytaKind", "locked", "ytaNative");

Object.assign(InteractiveFabricObject.ownDefaults, {
  borderColor: ACCENT,
  borderScaleFactor: 1.5,
  cornerColor: "#ffffff",
  cornerStrokeColor: ACCENT,
  cornerStyle: "circle",
  cornerSize: 11,
  touchCornerSize: 30,
  transparentCorners: false,
  padding: 4,
});

function removeTarget(_event: TPointerEvent, transform: Transform): boolean {
  const target = transform.target;
  const canvas = target.canvas;
  if (!canvas) return false;
  const objects = (target instanceof ActiveSelection ? target.getObjects() : [target]).filter((o) => !isLocked(o));
  canvas.discardActiveObject();
  removeObjects(canvas, objects);
  canvas.requestRenderAll();
  return true;
}

function renderDeleteIcon(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  _style: unknown,
  object: FabricObject,
): void {
  const radius = 10;
  ctx.save();
  ctx.translate(left, top);
  ctx.rotate(util.degreesToRadians(object.angle || 0));
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = DANGER;
  ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctx.shadowBlur = 4;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  const arm = radius * 0.4;
  ctx.beginPath();
  ctx.moveTo(-arm, -arm);
  ctx.lineTo(arm, arm);
  ctx.moveTo(arm, -arm);
  ctx.lineTo(-arm, arm);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

const deleteControl = new Control({
  x: -0.5,
  y: -0.5,
  offsetX: -14,
  offsetY: -14,
  sizeX: 22,
  sizeY: 22,
  touchSizeX: 36,
  touchSizeY: 36,
  cursorStyle: "pointer",
  actionName: "delete",
  mouseUpHandler: removeTarget,
  render: renderDeleteIcon,
});

FabricObject.createControls = () => ({
  controls: { ...controlsUtils.createObjectDefaultControls(), deleteControl },
});

// Text keeps only corner handles: stretching one axis would distort glyphs,
// and corner scaling is converted into a font size when the gesture ends.
IText.createControls = () => {
  const { ml: _ml, mr: _mr, mt: _mt, mb: _mb, ...corners } = controlsUtils.createObjectDefaultControls();
  return { controls: { ...corners, deleteControl } };
};

// Paragraphs also get side handles, which change the width they wrap to.
Textbox.createControls = () => {
  const { mt: _mt, mb: _mb, ...controls } = controlsUtils.createTextboxDefaultControls();
  return { controls: { ...controls, deleteControl } };
};

/**
 * Removes objects from the canvas. Text of the document itself is not
 * removed but marked as deleted, so the original stays erased.
 */
export function removeObjects(canvas: Canvas, objects: FabricObject[]): void {
  const removable: FabricObject[] = [];
  for (const object of objects) {
    if (isNative(object)) {
      markDeleted(object);
      canvas.fire("object:modified", { target: object } as never);
    } else {
      removable.push(object);
    }
  }
  if (removable.length > 0) canvas.remove(...removable);
  canvas.requestRenderAll();
}

// ── Object kinds and locking ───────────────────────────────────────────────

type Extra = { ytaKind?: ObjectKind; locked?: boolean };

function extra(object: FabricObject): Extra {
  return object as unknown as Extra;
}

function setExtra(object: FabricObject, props: Extra & Record<string, unknown>): void {
  object.set(props as Partial<FabricObject>);
}

export function kindOf(object: FabricObject): ObjectKind {
  const kind = extra(object).ytaKind;
  if (kind) return kind;
  if (object instanceof FabricText) return "text";
  if (object instanceof FabricImage) return "image";
  if (object instanceof Ellipse) return "ellipse";
  if (object instanceof Rect) return "rect";
  if (object instanceof Path) return "signature";
  return "image";
}

export function isText(object: FabricObject | undefined | null): object is FabricText {
  return object instanceof FabricText;
}

export function isLocked(object: FabricObject): boolean {
  return !!extra(object).locked;
}

/** Locked objects can be selected (to unlock them) but not moved, resized or edited. */
export function setLocked(object: FabricObject, locked: boolean): void {
  setExtra(object, {
    locked,
    lockMovementX: locked,
    lockMovementY: locked,
    lockScalingX: locked,
    lockScalingY: locked,
    lockRotation: locked,
    hasControls: !locked,
    borderDashArray: locked ? [5, 4] : null,
  });
  if (object instanceof IText) object.editable = !locked;
}

/** Restores runtime behaviour that is derived from serialised properties. */
export function prepareObject(object: FabricObject): FabricObject {
  if (isLocked(object)) setLocked(object, true);
  return object;
}

/** A multiple selection that includes a locked object cannot be dragged either. */
export function syncSelectionLock(canvas: Canvas): void {
  const active = canvas.getActiveObject();
  if (!(active instanceof ActiveSelection)) return;
  const locked = active.getObjects().some(isLocked);
  active.set({
    lockMovementX: locked,
    lockMovementY: locked,
    lockScalingX: locked,
    lockScalingY: locked,
    lockRotation: locked,
    hasControls: !locked,
  });
}

// ── Factories ──────────────────────────────────────────────────────────────

export function createText(content: string, style: TextStyle): IText {
  return new IText(content, {
    ...style,
    lineHeight: 1.16,
    editingBorderColor: ACCENT,
    cursorColor: ACCENT,
    selectionColor: "rgba(25, 118, 210, 0.25)",
  });
}

export async function createImage(url: string, maxWidth: number, maxHeight: number): Promise<FabricImage> {
  const image = await FabricImage.fromURL(url);
  const scale = Math.min(1, maxWidth / (image.width || 1), maxHeight / (image.height || 1));
  image.scale(scale);
  return image;
}

/** A handwritten signature as a single vector path, `width` scene units wide. */
export function createSignature(signature: SignatureData, width: number): Path {
  const path = new Path(signature.path, {
    fill: null,
    stroke: signature.color,
    strokeWidth: signature.strokeWidth,
    strokeLineCap: "round",
    strokeLineJoin: "round",
  });
  setExtra(path, { ytaKind: "signature" });
  path.scale(width / Math.max(1, path.width));
  return path;
}

/** Highlights are translucent so the text underneath stays readable. */
export const HIGHLIGHT_OPACITY = 0.45;

export const DEFAULT_SIZES: Record<DrawTool, { width: number; height: number }> = {
  rect: { width: 140, height: 90 },
  ellipse: { width: 120, height: 80 },
  line: { width: 140, height: 0 },
  arrow: { width: 140, height: 0 },
  highlight: { width: 160, height: 20 },
  redact: { width: 160, height: 24 },
};

export function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

export function arrowPath(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, strokeWidth * 3.5);
  const spread = Math.PI / 7;
  const hx1 = x2 - head * Math.cos(angle - spread);
  const hy1 = y2 - head * Math.sin(angle - spread);
  const hx2 = x2 - head * Math.cos(angle + spread);
  const hy2 = y2 - head * Math.sin(angle + spread);
  return `M ${x1} ${y1} L ${x2} ${y2} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`;
}

/**
 * Builds the object for a drawing tool from the two corners of the gesture
 * (or the two ends of a line), in scene units.
 */
export function createShape(
  tool: DrawTool,
  start: { x: number; y: number },
  end: { x: number; y: number },
  style: ShapeStyle,
  highlightColor: string,
): FabricObject {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  const center = { left: left + width / 2, top: top + height / 2 };

  let object: FabricObject;
  if (tool === "line" || tool === "arrow") {
    const d =
      tool === "arrow"
        ? arrowPath(start.x, start.y, end.x, end.y, style.strokeWidth)
        : linePath(start.x, start.y, end.x, end.y);
    object = new Path(d, {
      fill: null,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      strokeLineCap: "round",
      strokeLineJoin: "round",
      strokeUniform: true,
    });
  } else if (tool === "ellipse") {
    object = new Ellipse({
      ...center,
      rx: width / 2,
      ry: height / 2,
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      strokeUniform: true,
    });
  } else if (tool === "highlight") {
    object = new Rect({ ...center, width, height, fill: highlightColor, strokeWidth: 0, opacity: HIGHLIGHT_OPACITY });
  } else if (tool === "redact") {
    object = new Rect({ ...center, width, height, fill: "#000000", strokeWidth: 0 });
  } else {
    object = new Rect({
      ...center,
      width,
      height,
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      strokeUniform: true,
    });
  }
  setExtra(object, { ytaKind: tool });
  return object;
}

/**
 * Shapes keep a constant border while resized: a finished scale gesture is
 * turned into a new size. Text gets a new font size for the same reason.
 */
export function bakeScale(object: FabricObject | undefined): boolean {
  if (!object) return false;
  if (isNative(object)) return bakeNativeScale(object);
  const sx = object.scaleX || 1;
  const sy = object.scaleY || 1;
  if (Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3) return false;

  if (isText(object)) {
    object.set({ fontSize: Math.max(1, Math.round(object.fontSize * sy * 10) / 10), scaleX: 1, scaleY: 1 });
    object.initDimensions();
  } else if (object instanceof Ellipse) {
    object.set({ rx: object.rx * sx, ry: object.ry * sy, scaleX: 1, scaleY: 1 });
  } else if (object instanceof Rect) {
    object.set({ width: object.width * sx, height: object.height * sy, scaleX: 1, scaleY: 1 });
  } else {
    return false;
  }
  object.setCoords();
  return true;
}

// ── Selection helpers ──────────────────────────────────────────────────────

export function selectedObjects(canvas: Canvas): FabricObject[] {
  const active = canvas.getActiveObject();
  if (!active) return [];
  return active instanceof ActiveSelection ? active.getObjects() : [active];
}

function readTextStyle(text: FabricText): TextStyle {
  const scale = text.scaleY || 1;
  return {
    fontFamily: text.fontFamily,
    // A text resized inside a multiple selection keeps its scale until the
    // selection ends, so report the size the user actually sees.
    fontSize: Math.round(text.fontSize * scale * 10) / 10,
    fill: typeof text.fill === "string" ? normalizeHex(text.fill) : "#000000",
    fontWeight: isBoldWeight(text.fontWeight) ? "bold" : "normal",
    fontStyle: isItalicStyle(text.fontStyle) ? "italic" : "normal",
    underline: !!text.underline,
  };
}

const STROKED = new Set<ObjectKind>(["rect", "ellipse", "line", "arrow", "signature"]);

function readShapeStyle(object: FabricObject): ShapeStyle {
  return {
    stroke: typeof object.stroke === "string" ? normalizeHex(object.stroke) : "#000000",
    fill: typeof object.fill === "string" && object.fill !== "" ? normalizeHex(object.fill) : null,
    strokeWidth: Math.round((object.strokeWidth ?? 1) * 10) / 10,
  };
}

function stackRange(canvas: Canvas, objects: FabricObject[]): { canRaise: boolean; canLower: boolean } {
  const all = canvas.getObjects();
  const indices = objects.map((o) => all.indexOf(o)).sort((a, b) => a - b);
  const count = indices.length;
  const atTop = indices.every((index, i) => index === all.length - count + i);
  const atBottom = indices.every((index, i) => index === i);
  return { canRaise: !atTop, canLower: !atBottom };
}

function originalFonts(objects: FabricObject[]): SelectionInfo["originalFonts"] {
  const native = objects.find(isNative);
  if (!native) return [];
  return native.ytaNative.fonts.map((font) => ({ label: originalFontLabel(font.css) ?? font.name, css: font.css }));
}

export function describeSelection(canvas: Canvas): SelectionInfo | null {
  const active = canvas.getActiveObject();
  if (!active) return null;
  const objects = selectedObjects(canvas);
  const firstText = objects.find(isText);
  const firstShape = objects.find((o) => STROKED.has(kindOf(o)));
  const firstHighlight = objects.find((o) => kindOf(o) === "highlight");
  return {
    kind: objects.length > 1 ? "multiple" : kindOf(active),
    count: objects.length,
    angle: Math.round(active.angle || 0),
    flipX: !!active.flipX,
    flipY: !!active.flipY,
    opacity: active instanceof ActiveSelection ? (objects[0]?.opacity ?? 1) : (active.opacity ?? 1),
    text: firstText ? readTextStyle(firstText) : null,
    native: objects.some(isNative),
    originalFonts: originalFonts(objects),
    substituted: [...new Set(objects.filter(isNative).flatMap(substitutedChars))],
    shape: firstShape ? readShapeStyle(firstShape) : null,
    highlight: firstHighlight && typeof firstHighlight.fill === "string" ? normalizeHex(firstHighlight.fill) : null,
    locked: objects.every(isLocked),
    ...stackRange(canvas, objects),
  };
}

/** Objects of the selection that may be edited (locked ones are skipped). */
export function editableSelection(canvas: Canvas): FabricObject[] {
  return selectedObjects(canvas).filter((o) => !isLocked(o));
}

export function applyTextStyle(canvas: Canvas, style: Partial<TextStyle>): boolean {
  const texts = editableSelection(canvas).filter(isText);
  if (texts.length === 0) return false;
  for (const text of texts) {
    const { fontSize, ...rest } = style;
    text.set(rest);
    if (fontSize !== undefined) text.set("fontSize", fontSize / (text.scaleY || 1));
    if (isNative(text)) {
      // Document text keeps a style per character (its original fonts):
      // the change applies to every character instead of clearing them.
      const change: Record<string, unknown> = { ...rest };
      if (fontSize !== undefined) change.fontSize = fontSize / (text.scaleY || 1);
      text.setSelectionStyles(change, 0, text.text.length);
    } else if (text.styles && Object.keys(text.styles).length > 0) {
      // Per-character styles from typing would override object-level styles.
      text.set("styles", {});
    }
    text.initDimensions();
    text.setCoords();
  }
  canvas.getActiveObject()?.setCoords();
  canvas.requestRenderAll();
  return true;
}

export function applyShapeStyle(canvas: Canvas, style: Partial<ShapeStyle>, highlight?: string): boolean {
  let changed = false;
  for (const object of editableSelection(canvas)) {
    const kind = kindOf(object);
    if (kind === "highlight" && highlight) {
      object.set("fill", highlight);
      changed = true;
    } else if (STROKED.has(kind)) {
      setShapeStyle(object, kind, style);
      changed = true;
    }
  }
  if (changed) canvas.requestRenderAll();
  return changed;
}

function setShapeStyle(object: FabricObject, kind: ObjectKind, style: Partial<ShapeStyle>): void {
  if (style.stroke !== undefined) object.set("stroke", style.stroke);
  if (style.strokeWidth !== undefined) object.set("strokeWidth", style.strokeWidth);
  // Only closed shapes take a fill.
  if (style.fill !== undefined && (kind === "rect" || kind === "ellipse")) object.set("fill", style.fill);
  object.setCoords();
}

/** Changes the stacking order of the selection, keeping its internal order. */
export function arrange(canvas: Canvas, action: ArrangeAction): boolean {
  const all = canvas.getObjects();
  const objects = selectedObjects(canvas).sort((a, b) => all.indexOf(a) - all.indexOf(b));
  let changed = false;
  if (action === "front") {
    for (const object of objects) changed = canvas.bringObjectToFront(object) || changed;
  } else if (action === "back") {
    for (const object of [...objects].reverse()) changed = canvas.sendObjectToBack(object) || changed;
  } else if (action === "forward") {
    // "Intersecting" jumps over the next object that actually overlaps, so
    // every press makes a visible difference.
    for (const object of [...objects].reverse()) changed = canvas.bringObjectForward(object, true) || changed;
  } else {
    for (const object of objects) changed = canvas.sendObjectBackwards(object, true) || changed;
  }
  if (changed) canvas.requestRenderAll();
  return changed;
}

// ── Copy & paste ───────────────────────────────────────────────────────────

interface CanvasInternals {
  _toObject(instance: FabricObject, method: "toObject", props: string[]): Record<string, unknown>;
}

/**
 * Serialises the selection in page coordinates. Objects inside a multiple
 * selection are stored relative to it, so the canvas resolves that first.
 */
export function serializeSelection(canvas: Canvas): Record<string, unknown>[] {
  const internals = canvas as unknown as CanvasInternals;
  const all = canvas.getObjects();
  return selectedObjects(canvas)
    .sort((a, b) => all.indexOf(a) - all.indexOf(b))
    .map((object) => toPlainTextData(internals._toObject(object, "toObject", [])));
}

export function selectionText(canvas: Canvas): string {
  return selectedObjects(canvas)
    .filter(isText)
    .map((text) => text.text)
    .join("\n");
}

/** Adds serialised objects to the canvas, shifted by `offset`, and selects them. */
export async function pasteObjects(
  canvas: Canvas,
  data: Record<string, unknown>[],
  offset: number,
): Promise<FabricObject[]> {
  const objects = await util.enlivenObjects<FabricObject>(data);
  for (const object of objects) {
    object.set({ left: object.left + offset, top: object.top + offset });
    // Copies start unlocked so they can be placed.
    setLocked(object, false);
    object.setCoords();
    canvas.add(object);
  }
  canvas.discardActiveObject();
  if (objects.length === 1) canvas.setActiveObject(objects[0]);
  else if (objects.length > 1) canvas.setActiveObject(new ActiveSelection(objects, { canvas }));
  canvas.requestRenderAll();
  return objects;
}

// ── Alignment guides ───────────────────────────────────────────────────────

const GUIDE_COLOR = "#e5398f";

/**
 * Snaps moving objects to the page edges and centre and to the edges and
 * centres of other objects, drawing a guide where they align. Holding Alt
 * moves freely.
 */
export function installAlignmentGuides(
  canvas: Canvas,
  pageSize: () => { width: number; height: number },
): () => void {
  let guides: { x: number[]; y: number[] } = { x: [], y: [] };

  const onMoving = ({ target, e }: { target: FabricObject; e: TPointerEvent }) => {
    guides = { x: [], y: [] };
    if (!target || (e as MouseEvent).altKey) return;
    target.setCoords();
    const threshold = 6 / canvas.getZoom();
    const { width, height } = pageSize();
    const xs = [0, width / 2, width];
    const ys = [0, height / 2, height];
    const moving = new Set(target instanceof ActiveSelection ? target.getObjects() : [target]);
    for (const other of canvas.getObjects()) {
      if (moving.has(other) || !other.visible) continue;
      const r = other.getBoundingRect();
      xs.push(r.left, r.left + r.width / 2, r.left + r.width);
      ys.push(r.top, r.top + r.height / 2, r.top + r.height);
    }
    const box = target.getBoundingRect();
    const snap = (edges: number[], lines: number[]) => {
      let best: { delta: number; line: number } | null = null;
      for (const edge of edges) {
        for (const line of lines) {
          const delta = line - edge;
          if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
            best = { delta, line };
          }
        }
      }
      return best;
    };
    const x = snap([box.left, box.left + box.width / 2, box.left + box.width], xs);
    const y = snap([box.top, box.top + box.height / 2, box.top + box.height], ys);
    if (x) target.set("left", target.left + x.delta);
    if (y) target.set("top", target.top + y.delta);
    if (x || y) target.setCoords();
    guides = { x: x ? [x.line] : [], y: y ? [y.line] : [] };
  };

  const onAfterRender = () => {
    if (guides.x.length === 0 && guides.y.length === 0) return;
    const ctx = canvas.contextTop;
    const vpt = canvas.viewportTransform;
    const ratio = canvas.getRetinaScaling();
    canvas.clearContext(ctx);
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    const w = canvas.getWidth();
    const h = canvas.getHeight();
    for (const x of guides.x) {
      const sx = Math.round(x * vpt[0] + vpt[4]) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
    }
    for (const y of guides.y) {
      const sy = Math.round(y * vpt[3] + vpt[5]) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }
    ctx.restore();
  };

  const onUp = () => {
    if (guides.x.length === 0 && guides.y.length === 0) return;
    guides = { x: [], y: [] };
    canvas.clearContext(canvas.contextTop);
    canvas.requestRenderAll();
  };

  canvas.on("object:moving", onMoving);
  canvas.on("after:render", onAfterRender);
  canvas.on("mouse:up", onUp);
  return () => {
    canvas.off("object:moving", onMoving);
    canvas.off("after:render", onAfterRender);
    canvas.off("mouse:up", onUp);
  };
}

/** Preview of a drawing gesture on the canvas' top layer. */
export function drawShapePreview(
  canvas: Canvas,
  tool: DrawTool,
  start: { x: number; y: number },
  end: { x: number; y: number },
  style: ShapeStyle,
  highlightColor: string,
): void {
  const ctx = canvas.contextTop;
  const vpt = canvas.viewportTransform;
  const ratio = canvas.getRetinaScaling();
  canvas.clearContext(ctx);
  ctx.save();
  ctx.setTransform(ratio * vpt[0], 0, 0, ratio * vpt[3], ratio * vpt[4], ratio * vpt[5]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  ctx.lineWidth = style.strokeWidth;
  ctx.strokeStyle = style.stroke;
  if (tool === "highlight") {
    ctx.globalAlpha = HIGHLIGHT_OPACITY;
    ctx.fillStyle = highlightColor;
    ctx.fillRect(x, y, w, h);
  } else if (tool === "redact") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.fillRect(x, y, w, h);
  } else if (tool === "rect" || tool === "ellipse") {
    ctx.beginPath();
    if (tool === "rect") ctx.rect(x, y, w, h);
    else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    ctx.stroke();
  } else {
    const d = tool === "arrow" ? arrowPath(start.x, start.y, end.x, end.y, style.strokeWidth) : linePath(start.x, start.y, end.x, end.y);
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

export function clearTopLayer(canvas: Canvas): void {
  canvas.clearContext(canvas.contextTop);
}

function normalizeHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${Array.from(color.slice(1), (c) => c + c).join("")}`.toLowerCase();
  }
  return color;
}
