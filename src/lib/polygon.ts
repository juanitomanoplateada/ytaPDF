/**
 * Small geometry on convex polygons (lists of corners), enough to tell how
 * much of a glyph, an image or an object lies under a redaction box.
 */

export type Point = [number, number];

/** Area of a simple polygon, whatever its orientation. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** The part of `subject` inside the convex polygon `clip` (Sutherland–Hodgman). */
export function clipConvex(subject: Point[], clip: Point[]): Point[] {
  const orientation = Math.sign(signedArea(clip)) || 1;
  let output = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const side = ([x, y]: Point) => orientation * ((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const sc = side(current);
      const sp = side(previous);
      if (sc >= 0) {
        if (sp < 0) output.push(intersection(previous, current, sp, sc));
        output.push(current);
      } else if (sp >= 0) {
        output.push(intersection(previous, current, sp, sc));
      }
    }
  }
  return output;
}

function intersection(p: Point, q: Point, sp: number, sq: number): Point {
  const t = sp / (sp - sq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Area shared by a polygon and a convex polygon. */
export function overlapArea(subject: Point[], convex: Point[]): number {
  if (subject.length < 3 || convex.length < 3) return 0;
  return polygonArea(clipConvex(subject, convex));
}

/** Whether a point lies inside a convex polygon, allowing `tolerance` units outside its edges. */
export function insideConvex([x, y]: Point, convex: Point[], tolerance = 0): boolean {
  const orientation = Math.sign(signedArea(convex)) || 1;
  for (let i = 0; i < convex.length; i++) {
    const [ax, ay] = convex[i];
    const [bx, by] = convex[(i + 1) % convex.length];
    const length = Math.hypot(bx - ax, by - ay);
    if (length === 0) continue;
    const distance = (orientation * ((bx - ax) * (y - ay) - (by - ay) * (x - ax))) / length;
    if (distance < -tolerance) return false;
  }
  return true;
}

/** Centre of a polygon's corners. */
export function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
  }
  return [x / (points.length || 1), y / (points.length || 1)];
}
