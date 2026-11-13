/**
 * Alignment and distribution of objects by their bounding boxes, in scene
 * units. Each function returns how far each box must move.
 */

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Shift {
  dx: number;
  dy: number;
}

export function unionBounds(boxes: Bounds[]): Bounds {
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Aligns every box to the same edge or centre of `reference`: the union of
 * the boxes when several are aligned to each other, or the page for one.
 */
export function alignShifts(boxes: Bounds[], mode: AlignMode, reference: Bounds = unionBounds(boxes)): Shift[] {
  return boxes.map((box) => {
    switch (mode) {
      case "left":
        return { dx: reference.left - box.left, dy: 0 };
      case "center":
        return { dx: reference.left + reference.width / 2 - (box.left + box.width / 2), dy: 0 };
      case "right":
        return { dx: reference.left + reference.width - (box.left + box.width), dy: 0 };
      case "top":
        return { dx: 0, dy: reference.top - box.top };
      case "middle":
        return { dx: 0, dy: reference.top + reference.height / 2 - (box.top + box.height / 2) };
      case "bottom":
        return { dx: 0, dy: reference.top + reference.height - (box.top + box.height) };
    }
  });
}

/**
 * Spreads boxes so the gaps between them are equal, keeping the first and
 * the last (along the axis) where they are. Needs at least three boxes.
 */
export function distributeShifts(boxes: Bounds[], axis: "horizontal" | "vertical"): Shift[] {
  const shifts: Shift[] = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return shifts;
  const start = (b: Bounds) => (axis === "horizontal" ? b.left : b.top);
  const size = (b: Bounds) => (axis === "horizontal" ? b.width : b.height);
  const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]) + size(boxes[a]) / 2 - (start(boxes[b]) + size(boxes[b]) / 2));
  const first = boxes[order[0]];
  const last = boxes[order.at(-1)!];
  const total = order.reduce((sum, i) => sum + size(boxes[i]), 0);
  const gap = (start(last) + size(last) - start(first) - total) / (order.length - 1);
  let position = start(first);
  for (const i of order) {
    const delta = position - start(boxes[i]);
    shifts[i] = axis === "horizontal" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
    position += size(boxes[i]) + gap;
  }
  return shifts;
}

export const MM_PER_POINT = 25.4 / 72;
