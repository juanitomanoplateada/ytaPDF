import { Color, Ellipse, FabricImage, FabricText, Path, Rect, util, type FabricObject } from "fabric";
import { applyToPoint, IDENTITY, multiply, pathToSvg, type Matrix, type PathCommand } from "../geometry";
import type { PageAnnotations } from "../editor.svelte";
import type { Drawable, Rgb, TextLine } from "./drawing";

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

function parseColor(value: unknown): { color: Rgb; alpha: number } | null {
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
    const matrix = object.calcTransformMatrix() as Matrix;
    const opacity = object.opacity ?? 1;
    const fill = parseColor(object.fill);
    const stroke = object.strokeWidth > 0 ? parseColor(object.stroke) : null;

    if (object instanceof FabricText) {
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
      drawables.push({
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
      });
    } else if (object instanceof FabricImage) {
      drawables.push({ kind: "image", matrix, src: object.getSrc(), width: object.width, height: object.height, opacity });
    } else if (object instanceof Path) {
      const commands = object.path as unknown as PathCommand[];
      const { x: ox, y: oy } = object.pathOffset;
      const common = {
        kind: "path" as const,
        opacity: opacity * (stroke?.alpha ?? fill?.alpha ?? 1),
        stroke: stroke?.color ?? null,
        strokeWidth: object.strokeWidth,
        fill: fill?.color ?? null,
        lineCap: object.strokeLineCap === "round" ? ("round" as const) : object.strokeLineCap === "square" ? ("square" as const) : ("butt" as const),
        lineJoin: object.strokeLineJoin === "round" ? ("round" as const) : object.strokeLineJoin === "bevel" ? ("bevel" as const) : ("miter" as const),
      };
      if (object.strokeUniform) {
        // The stroke keeps its width however the object is scaled, so the
        // path is mapped to page space and drawn without a scaling matrix.
        drawables.push({
          ...common,
          matrix: IDENTITY,
          d: pathToSvg(commands, (x, y) => applyToPoint(matrix, x - ox, y - oy)),
        });
      } else {
        drawables.push({ ...common, matrix, d: pathToSvg(commands, (x, y) => [x - ox, y - oy]) });
      }
    } else if (object instanceof Ellipse || object instanceof Rect) {
      const sx = object.scaleX || 1;
      const sy = object.scaleY || 1;
      const uniform = object.strokeUniform;
      const shape = {
        matrix: uniform ? withoutScale(matrix, sx, sy) : matrix,
        opacity: opacity * (fill?.alpha ?? stroke?.alpha ?? 1),
        fill: fill?.color ?? null,
        stroke: stroke?.color ?? null,
        strokeWidth: object.strokeWidth,
      };
      if (object instanceof Ellipse) {
        drawables.push({ kind: "ellipse", ...shape, rx: object.rx * (uniform ? sx : 1), ry: object.ry * (uniform ? sy : 1) });
      } else {
        drawables.push({
          kind: "rect",
          ...shape,
          width: object.width * (uniform ? sx : 1),
          height: object.height * (uniform ? sy : 1),
        });
      }
    }
  }
  return drawables;
}

/** Whether a page has redaction boxes, which force it to be rasterised. */
export function hasRedactions(data: PageAnnotations | undefined): boolean {
  return !!data?.objects.some((object) => object.ytaKind === "redact");
}
