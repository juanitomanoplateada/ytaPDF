import {
  ActiveSelection,
  Control,
  controlsUtils,
  FabricImage,
  FabricObject,
  FabricText,
  IText,
  InteractiveFabricObject,
  util,
  type Canvas,
  type TPointerEvent,
  type Transform,
} from "fabric";
import { isBoldWeight, isItalicStyle } from "./fonts";
import type { SelectionInfo, TextStyle } from "./editor.svelte";

const ACCENT = "#1976d2";
const DANGER = "#e5484d";

// ── Global look & controls (applied once, before any object is created) ────

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
  const objects = target instanceof ActiveSelection ? target.getObjects() : [target];
  canvas.discardActiveObject();
  canvas.remove(...objects);
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

// ── Factories ──────────────────────────────────────────────────────────────

export function isText(object: FabricObject | undefined | null): object is FabricText {
  return object instanceof FabricText;
}

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

export function describeSelection(canvas: Canvas): SelectionInfo | null {
  const active = canvas.getActiveObject();
  if (!active) return null;
  const objects = selectedObjects(canvas);
  const firstText = objects.find(isText);
  return {
    kind: objects.length > 1 ? "multiple" : isText(active) ? "text" : "image",
    count: objects.length,
    angle: Math.round(active.angle || 0),
    flipX: !!active.flipX,
    flipY: !!active.flipY,
    opacity: active instanceof ActiveSelection ? (objects[0]?.opacity ?? 1) : (active.opacity ?? 1),
    text: firstText ? readTextStyle(firstText) : null,
  };
}

export function applyTextStyle(canvas: Canvas, style: Partial<TextStyle>): boolean {
  const texts = selectedObjects(canvas).filter(isText);
  if (texts.length === 0) return false;
  for (const text of texts) {
    const { fontSize, ...rest } = style;
    text.set(rest);
    if (fontSize !== undefined) text.set("fontSize", fontSize / (text.scaleY || 1));
    // Per-character styles from typing would override object-level styles.
    if (text.styles && Object.keys(text.styles).length > 0) text.set("styles", {});
    text.initDimensions();
    text.setCoords();
  }
  canvas.getActiveObject()?.setCoords();
  canvas.requestRenderAll();
  return true;
}

/**
 * Converts a finished corner-scale gesture on a text into a real font size,
 * so the export and the toolbar work with the size the user sees.
 */
export function bakeTextScale(object: FabricObject | undefined): boolean {
  if (!isText(object)) return false;
  const scale = object.scaleY || 1;
  if (Math.abs(scale - 1) < 1e-3 && Math.abs((object.scaleX || 1) - 1) < 1e-3) return false;
  object.set({
    fontSize: Math.max(1, Math.round(object.fontSize * scale * 10) / 10),
    scaleX: 1,
    scaleY: 1,
  });
  object.initDimensions();
  object.setCoords();
  return true;
}

function normalizeHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${[...color.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  }
  return color;
}
