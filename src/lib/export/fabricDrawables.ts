import { Color, FabricImage, FabricText, util, type FabricObject } from "fabric";
import type { Matrix } from "../geometry";
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

function parseColor(fill: unknown): { color: Rgb; alpha: number } {
  if (typeof fill !== "string" || fill === "") return { color: { r: 0, g: 0, b: 0 }, alpha: 1 };
  const [r, g, b, alpha] = new Color(fill).getSource();
  return { color: { r: r / 255, g: g / 255, b: b / 255 }, alpha: alpha ?? 1 };
}

/**
 * Rebuilds the Fabric objects of a page and describes each one as a drawing
 * instruction in object-local space, using Fabric's own transform and line
 * metrics so the PDF matches the canvas.
 */
export async function fabricToDrawables(data: PageAnnotations): Promise<Drawable[]> {
  const objects = await util.enlivenObjects<FabricObject>(data.objects);
  const drawables: Drawable[] = [];

  for (const object of objects) {
    if (!object.visible) continue;
    const matrix = object.calcTransformMatrix() as Matrix;
    const opacity = object.opacity ?? 1;

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
      const { color, alpha } = parseColor(object.fill);
      drawables.push({
        kind: "text",
        matrix,
        lines,
        fontSize: object.fontSize,
        fontFamily: object.fontFamily,
        fontWeight: object.fontWeight,
        fontStyle: object.fontStyle,
        color,
        opacity: opacity * alpha,
        underline: !!object.underline,
      });
    } else if (object instanceof FabricImage) {
      drawables.push({
        kind: "image",
        matrix,
        src: object.getSrc(),
        width: object.width,
        height: object.height,
        opacity,
      });
    }
  }
  return drawables;
}
