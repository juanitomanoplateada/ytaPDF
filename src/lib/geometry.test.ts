import { describe, expect, it } from "vitest";
import { applyToPoint, invert, multiply, type Matrix } from "./geometry";

function expectMatrixClose(actual: Matrix, expected: Matrix) {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
}

describe("geometry", () => {
  const rotateScaleTranslate: Matrix = [0, 2, -2, 0, 30, -12];

  it("composes transforms applying the inner one first", () => {
    const translate: Matrix = [1, 0, 0, 1, 10, 5];
    const scale: Matrix = [2, 0, 0, 3, 0, 0];
    expect(applyToPoint(multiply(translate, scale), 1, 1)).toEqual([12, 8]);
    expect(applyToPoint(multiply(scale, translate), 1, 1)).toEqual([22, 18]);
  });

  it("inverts a transform", () => {
    expectMatrixClose(multiply(rotateScaleTranslate, invert(rotateScaleTranslate)), [1, 0, 0, 1, 0, 0]);
    const [x, y] = applyToPoint(rotateScaleTranslate, 7, -3);
    const [bx, by] = applyToPoint(invert(rotateScaleTranslate), x, y);
    expect(bx).toBeCloseTo(7, 9);
    expect(by).toBeCloseTo(-3, 9);
  });

  it("refuses singular matrices", () => {
    expect(() => invert([1, 2, 2, 4, 0, 0])).toThrow();
  });
});
