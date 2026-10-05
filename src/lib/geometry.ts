/**
 * Affine transforms in the PDF/Canvas convention `[a, b, c, d, e, f]`, which
 * maps a point (x, y) to (a·x + c·y + e, b·x + d·y + f).
 */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Mirrors the Y axis: converts between y-up drawing space and y-down Fabric space. */
export const FLIP_Y: Matrix = [1, 0, 0, -1, 0, 0];

/** Composition `outer ∘ inner`: the result applies `inner` first, then `outer`. */
export function multiply(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    throw new Error("La matriz de transformación no es invertible.");
  }
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Transform from the editor's scene space (the PDF.js viewport at scale 1,
 * y pointing down, page rotation already applied) to PDF user space.
 * `viewportTransform` is `page.getViewport({ scale: 1 }).transform`.
 */
export function sceneToPdf(viewportTransform: number[]): Matrix {
  return invert(viewportTransform as Matrix);
}

/**
 * Matrix to `cm` before drawing an object whose content is laid out in a
 * y-up space centred on the object. `objectMatrix` is Fabric's
 * `calcTransformMatrix()` (object-local y-down space → scene).
 */
export function objectToPdf(sceneToPdfMatrix: Matrix, objectMatrix: Matrix): Matrix {
  return multiply(sceneToPdfMatrix, multiply(objectMatrix, FLIP_Y));
}
