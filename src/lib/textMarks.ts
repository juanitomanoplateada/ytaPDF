/**
 * Geometry for marking selected text: the rectangles the browser reports for
 * a selection are merged into one box per line, and each box becomes a
 * highlight, or a line under or through the text. Everything is in the
 * page's scene units (the page as the editor shows it).
 */

export type TextMarkKind = "highlight" | "underline" | "strikeout";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Merges the boxes of a selection into lines. Text runs left to right on an
 * upright page and top to bottom (or bottom to top) when the page is turned
 * 90° or 270°, so `vertical` lines are merged along y instead of x.
 */
export function mergeLines(boxes: Box[], vertical = false): Box[] {
  const along = (b: Box) => (vertical ? { start: b.y, size: b.height, cross: b.x, thickness: b.width } : { start: b.x, size: b.width, cross: b.y, thickness: b.height });
  const sorted = boxes
    .filter((b) => b.width > 0.5 && b.height > 0.5)
    .sort((a, b) => along(a).cross - along(b).cross || along(a).start - along(b).start);
  const lines: Box[] = [];
  for (const box of sorted) {
    const b = along(box);
    const line = lines.find((candidate) => {
      const c = along(candidate);
      const overlap = Math.min(c.cross + c.thickness, b.cross + b.thickness) - Math.max(c.cross, b.cross);
      // Same line: they overlap across most of their height, and nearly touch along it.
      const gap = Math.max(c.start, b.start) - Math.min(c.start + c.size, b.start + b.size);
      return overlap > Math.min(c.thickness, b.thickness) * 0.5 && gap < Math.max(c.thickness, b.thickness) * 1.5;
    });
    if (!line) {
      lines.push({ ...box });
      continue;
    }
    const x = Math.min(line.x, box.x);
    const y = Math.min(line.y, box.y);
    line.width = Math.max(line.x + line.width, box.x + box.width) - x;
    line.height = Math.max(line.y + line.height, box.y + box.height) - y;
    line.x = x;
    line.y = y;
  }
  return lines;
}

/**
 * Where to draw a line under or through the text of a line box. `rotation`
 * is the page's rotation on screen: it decides which side the letters stand on.
 */
export function markLine(kind: "underline" | "strikeout", box: Box, rotation: number): { from: [number, number]; to: [number, number]; width: number } {
  const turn = ((rotation % 360) + 360) % 360;
  const vertical = turn === 90 || turn === 270;
  const thickness = vertical ? box.width : box.height;
  // Fraction of the box, from the top of the letters towards their baseline side.
  const depth = kind === "underline" ? 0.9 : 0.55;
  const width = Math.max(0.75, Math.round(thickness * 0.07 * 100) / 100);
  if (turn === 0) {
    const y = box.y + box.height * depth;
    return { from: [box.x, y], to: [box.x + box.width, y], width };
  }
  if (turn === 180) {
    const y = box.y + box.height * (1 - depth);
    return { from: [box.x, y], to: [box.x + box.width, y], width };
  }
  // Turned clockwise, the bottom of the letters faces left; counterclockwise, right.
  const x = turn === 90 ? box.x + box.width * (1 - depth) : box.x + box.width * depth;
  return { from: [x, box.y], to: [x, box.y + box.height], width };
}
