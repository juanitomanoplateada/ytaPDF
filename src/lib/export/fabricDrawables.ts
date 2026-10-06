import { Color, Ellipse, FabricImage, FabricText, Path, Rect, util, type FabricObject } from "fabric";
import { applyToPoint, IDENTITY, multiply, pathToSvg, type Matrix, type PathCommand } from "../geometry";
import type { PageAnnotations } from "../editor.svelte";
import type { Drawable, PathDrawable, Rgb, TextLine } from "./drawing";

/**
 * Fabric internals used to lay text out exactly like the canvas does. They are
 * stable across Fabric 6 and 7 but not part of its public typings.
 */
interface TextLayout {
  textLines: string[];
  _fontSizeFraction: number;
  _getTopOffset(): number;
  _getLeftOffset(): number;
  _getLineLeftOffset(lineIndex: number): number;
  getHeightOfLine(lineIndex: number): number;
  getHeightOfLineImpl(lineIndex: number): number;
}

interface ParsedColor {
  color: Rgb;
  alpha: number;
}

/** How an object is placed and painted, shared by every kind of drawable. */
interface Paint {
  matrix: Matrix;
  opacity: number;
  fill: ParsedColor | null;
  stroke: ParsedColor | null;
}

function parseColor(value: unknown): ParsedColor | null {
  if (typeof value !== "string" || value === "" || value === "transparent") return null;
  const [r, g, b, alpha] = new Color(value).getSource();
  return { color: { r: r / 255, g: g / 255, b: b / 255 }, alpha: alpha ?? 1 };
}

/** Removes the scale from a matrix so a shape can be drawn at its real size. */
function withoutScale(matrix: Matrix, scaleX: number, scaleY: number): Matrix {
  return multiply(matrix, [1 / (scaleX || 1), 0, 0, 1 / (scaleY || 1), 0, 0]);
}

/**
 * Rebuilds the Fabric objects of a page and describes each one as a drawing
 * instruction, using Fabric's own transforms and line metrics so the PDF
 * matches the canvas. Redaction boxes are left out: pages with them are
 * exported as an image instead.
 */
export async function fabricToDrawables(data: PageAnnotations): Promise<Drawable[]> {
  const objects = await util.enlivenObjects<FabricObject>(data.objects);
  const drawables: Drawable[] = [];

  for (const object of objects) {
    if (!object.visible) continue;
    const kind = (object as unknown as { ytaKind?: string }).ytaKind;
    if (kind === "redact") continue;
    const drawable = toDrawable(object);
    if (drawable) drawables.push(drawable);
  }
  return drawables;
}

function toDrawable(object: FabricObject): Drawable | null {
  const paint: Paint = {
    matrix: object.calcTransformMatrix() as Matrix,
    opacity: object.opacity ?? 1,
    fill: parseColor(object.fill),
    stroke: object.strokeWidth > 0 ? parseColor(object.stroke) : null,
  };
  if (object instanceof FabricText) return textDrawable(object, paint);
  if (object instanceof FabricImage) {
    const { matrix, opacity } = paint;
    return { kind: "image", matrix, src: object.getSrc(), width: object.width, height: object.height, opacity };
  }
  if (object instanceof Path) return pathDrawable(object, paint);
  if (object instanceof Ellipse || object instanceof Rect) return shapeDrawable(object, paint);
  return null;
}

function textDrawable(object: FabricText, { matrix, opacity, fill }: Paint): Drawable {
  const layout = object as unknown as TextLayout;
  const lines: TextLine[] = [];
  let lineTop = layout._getTopOffset();
  for (let i = 0; i < layout.textLines.length; i++) {
    lines.push({
      text: layout.textLines[i],
      x: layout._getLeftOffset() + layout._getLineLeftOffset(i),
      baseline: lineTop + layout.getHeightOfLineImpl(i) * (1 - layout._fontSizeFraction),
    });
    lineTop += layout.getHeightOfLine(i);
  }
  return {
    kind: "text",
    matrix,
    lines,
    fontSize: object.fontSize,
    fontFamily: object.fontFamily,
    fontWeight: object.fontWeight,
    fontStyle: object.fontStyle,
    color: fill?.color ?? { r: 0, g: 0, b: 0 },
    opacity: opacity * (fill?.alpha ?? 1),
    underline: !!object.underline,
  };
}

function pathDrawable(object: Path, { matrix, opacity, fill, stroke }: Paint): Drawable {
  const commands = object.path as unknown as PathCommand[];
  const { x: ox, y: oy } = object.pathOffset;
  const common = {
    kind: "path" as const,
    opacity: opacity * (stroke?.alpha ?? fill?.alpha ?? 1),
    stroke: stroke?.color ?? null,
    strokeWidth: object.strokeWidth,
    fill: fill?.color ?? null,
    lineCap: lineCapOf(object.strokeLineCap),
    lineJoin: lineJoinOf(object.strokeLineJoin),
  };
  if (object.strokeUniform) {
    // The stroke keeps its width however the object is scaled, so the
    // path is mapped to page space and drawn without a scaling matrix.
    return { ...common, matrix: IDENTITY, d: pathToSvg(commands, (x, y) => applyToPoint(matrix, x - ox, y - oy)) };
  }
  return { ...common, matrix, d: pathToSvg(commands, (x, y) => [x - ox, y - oy]) };
}

function lineCapOf(cap: string): PathDrawable["lineCap"] {
  return cap === "round" || cap === "square" ? cap : "butt";
}

function lineJoinOf(join: string): PathDrawable["lineJoin"] {
  return join === "round" || join === "bevel" ? join : "miter";
}

function shapeDrawable(object: Ellipse | Rect, { matrix, opacity, fill, stroke }: Paint): Drawable {
  const sx = object.scaleX || 1;
  const sy = object.scaleY || 1;
  // A uniform stroke keeps its width when scaled, so the scale moves from
  // the matrix into the shape's size.
  const uniform = object.strokeUniform;
  const [kx, ky] = uniform ? [sx, sy] : [1, 1];
  const shape = {
    matrix: uniform ? withoutScale(matrix, sx, sy) : matrix,
    opacity: opacity * (fill?.alpha ?? stroke?.alpha ?? 1),
    fill: fill?.color ?? null,
    stroke: stroke?.color ?? null,
    strokeWidth: object.strokeWidth,
  };
  if (object instanceof Ellipse) return { kind: "ellipse", ...shape, rx: object.rx * kx, ry: object.ry * ky };
  return { kind: "rect", ...shape, width: object.width * kx, height: object.height * ky };
}

/** Whether a page has redaction boxes, which force it to be rasterised. */
export function hasRedactions(data: PageAnnotations | undefined): boolean {
  return !!data?.objects.some((object) => object.ytaKind === "redact");
}
