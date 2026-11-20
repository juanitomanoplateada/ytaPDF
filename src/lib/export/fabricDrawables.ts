import { Color, Ellipse, FabricImage, FabricText, Group, Path, Rect, util, type FabricObject } from "fabric";
import { applyToPoint, IDENTITY, multiply, pathToSvg, type Matrix, type PathCommand } from "../geometry";
import type { LinkTarget, PageAnnotations } from "../editor.svelte";
import { isNative } from "../nativeText";
import { overlapArea, type Point } from "../polygon";
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
  // Color always gives an alpha (1 when the value has none).
  return { color: { r: r / 255, g: g / 255, b: b / 255 }, alpha };
}

/** Removes the scale from a matrix so a shape can be drawn at its real size. */
function withoutScale(matrix: Matrix, scaleX: number, scaleY: number): Matrix {
  return multiply(matrix, [1 / scaleX, 0, 0, 1 / scaleY, 0, 0]);
}

/**
 * Rebuilds the Fabric objects of a page and describes each one as a drawing
 * instruction, using Fabric's own transforms and line metrics so the PDF
 * matches the canvas. Redaction boxes are drawn as the opaque boxes they
 * are: what was under them has already been removed from the page.
 */
export async function fabricToDrawables(data: PageAnnotations): Promise<Drawable[]> {
  const objects = await util.enlivenObjects<FabricObject>(data.objects);
  const drawables: Drawable[] = [];

  const visit = (object: FabricObject, opacity: number) => {
    if (!object.visible) return;
    const kind = (object as unknown as { ytaKind?: string }).ytaKind;
    // Document text is rewritten in the content; notes and links become annotations.
    if (isNative(object) || kind === "note" || kind === "link") return;
    if (object instanceof Group) {
      // Children's transforms already include the group's (they know their group).
      for (const child of object.getObjects()) visit(child, opacity * object.opacity);
      return;
    }
    const drawable = toDrawable(object, opacity);
    if (drawable) drawables.push(drawable);
  };
  for (const object of objects) visit(object, 1);
  return drawables;
}

function toDrawable(object: FabricObject, parentOpacity = 1): Drawable | null {
  const paint: Paint = {
    matrix: object.calcTransformMatrix() as Matrix,
    // Fabric objects always have an opacity (1 by default).
    opacity: object.opacity * parentOpacity,
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
    linethrough: !!object.linethrough,
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
  // Fabric never lets a scale reach 0: it clamps it to a minimum.
  const sx = object.scaleX;
  const sy = object.scaleY;
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

/** Objects that show nothing of their own: covering them with a redaction box hides nothing. */
const PLAIN_SHAPES = new Set(["rect", "ellipse", "line", "arrow", "highlight", "redact", "decoration", "note", "link"]);

/** Corners of an object in scene space, its stroke included. */
function cornersOf(object: FabricObject): Point[] {
  const matrix = object.calcTransformMatrix() as Matrix;
  const stroke = object.stroke && object.strokeWidth > 0 ? object.strokeWidth : 0;
  const w = (object.width + stroke) / 2;
  const h = (object.height + stroke) / 2;
  return [
    applyToPoint(matrix, -w, -h),
    applyToPoint(matrix, w, -h),
    applyToPoint(matrix, w, h),
    applyToPoint(matrix, -w, h),
  ];
}

/**
 * Redaction boxes of a page (scene space), and whether one covers an object
 * of the page's own annotations that shows something (text, an image, a
 * drawing): those are only hidden, not removed, so the page has to be
 * exported as an image.
 */
export async function redactionAreas(data: PageAnnotations): Promise<{ areas: Point[][]; coversContent: boolean }> {
  const objects = await util.enlivenObjects<FabricObject>(data.objects);
  const areas: Point[][] = [];
  const below: Point[][] = [];
  let coversContent = false;
  const visit = (object: FabricObject) => {
    if (!object.visible) return;
    const kind = (object as unknown as { ytaKind?: string }).ytaKind;
    if (object instanceof Group) {
      for (const child of object.getObjects()) visit(child);
      return;
    }
    if (kind === "redact") {
      const area = cornersOf(object);
      if (below.some((shape) => overlapArea(shape, area) > 0.5)) coversContent = true;
      areas.push(area);
    } else if (!PLAIN_SHAPES.has(kind ?? "") && !isNative(object)) {
      below.push(cornersOf(object));
    }
  };
  for (const object of objects) visit(object);
  return { areas, coversContent };
}

/** A note or a link of a page, in scene space, before it becomes a PDF annotation. */
export interface SceneAnnotation {
  kind: "note" | "link";
  corners: Point[];
  text: string;
  color: Rgb;
  link: LinkTarget | null;
}

/** The notes and links of a page, which are exported as PDF annotations. */
export async function sceneAnnotations(data: PageAnnotations): Promise<SceneAnnotation[]> {
  if (!data.objects.some(mayHoldAnnotations)) return [];
  const objects = await util.enlivenObjects<FabricObject>(data.objects);
  const found: SceneAnnotation[] = [];
  const visit = (object: FabricObject) => {
    if (!object.visible) return;
    if (object instanceof Group) {
      for (const child of object.getObjects()) visit(child);
      return;
    }
    const kind = (object as unknown as { ytaKind?: string }).ytaKind;
    if (kind !== "note" && kind !== "link") return;
    const background = parseColor((object as FabricObject & { backgroundColor?: string }).backgroundColor);
    found.push({
      kind,
      corners: cornersOf(object),
      text: object instanceof FabricText ? object.text : "",
      color: background?.color ?? { r: 1, g: 0.95, b: 0.63 },
      link: (object as unknown as { ytaLink?: LinkTarget }).ytaLink ?? null,
    });
  };
  for (const object of objects) visit(object);
  return found;
}

function mayHoldAnnotations(object: Record<string, unknown>): boolean {
  return (
    object.ytaKind === "note" ||
    object.ytaKind === "link" ||
    (Array.isArray(object.objects) && (object.objects as Record<string, unknown>[]).some(mayHoldAnnotations))
  );
}

/** Whether a page has redaction boxes. */
export function hasRedactions(data: PageAnnotations | undefined): boolean {
  const redacts = (object: Record<string, unknown>): boolean =>
    object.ytaKind === "redact" ||
    (Array.isArray(object.objects) && (object.objects as Record<string, unknown>[]).some(redacts));
  return !!data?.objects.some(redacts);
}
