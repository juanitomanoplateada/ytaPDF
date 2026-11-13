import { applyToPoint, invert, type Matrix } from "./geometry";
import type { Box } from "./pdfjs";

/**
 * Cropping in the editor's scene (the page as shown, y down) and in PDF user
 * space, where the crop box lives.
 */

/** A scene rectangle as the PDF box that covers it, through the viewport transform. */
export function sceneRectToBox(
  viewportTransform: number[],
  rect: { x0: number; y0: number; x1: number; y1: number },
): Box {
  const toPdf = invert(viewportTransform as Matrix);
  const corners = [
    applyToPoint(toPdf, rect.x0, rect.y0),
    applyToPoint(toPdf, rect.x1, rect.y0),
    applyToPoint(toPdf, rect.x1, rect.y1),
    applyToPoint(toPdf, rect.x0, rect.y1),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return [round(Math.min(...xs)), round(Math.min(...ys)), round(Math.max(...xs)), round(Math.max(...ys))];
}

export function intersectBox(a: Box, b: Box): Box | null {
  const box: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
}

/**
 * How far content moves on screen when the viewport changes from `before`
 * to `after` (a new crop): where the old scene origin lands in the new scene.
 * Both viewports share scale and rotation, so this is a plain translation.
 */
export function cropShift(before: number[], after: number[]): [number, number] {
  const pdf = applyToPoint(invert(before as Matrix), 0, 0);
  const [x, y] = applyToPoint(after as Matrix, pdf[0], pdf[1]);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return [round(x), round(y)];
}
