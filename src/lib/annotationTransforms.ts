import type { PageAnnotations } from "./editor.svelte";

/** Clockwise rotations the editor applies to whole pages. */
export type QuarterTurn = 90 | 180 | 270;

export function normalizeRotation(degrees: number): number {
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

/**
 * Moves annotations along with a page rotated clockwise by `delta`, so they
 * stay on the same spot of the content. `width` and `height` are the page
 * size before the rotation, in scene units. Objects are positioned by their
 * centre (Fabric 7's default origin), so rotating the centre and adding the
 * turn to the angle is enough, flips included.
 */
export function rotateAnnotations(
  data: PageAnnotations,
  width: number,
  height: number,
  delta: QuarterTurn,
): PageAnnotations {
  const objects = data.objects.map((object) => {
    const x = Number(object.left ?? 0);
    const y = Number(object.top ?? 0);
    const [left, top] =
      delta === 90 ? [height - y, x] : delta === 180 ? [width - x, height - y] : [y, width - x];
    return {
      ...object,
      left,
      top,
      angle: normalizeAngle(Number(object.angle ?? 0) + delta),
    };
  });
  return { ...data, objects };
}

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}
