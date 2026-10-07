/** A fill colour as the content stream set it, reduced to a device space. */
export interface FillColor {
  space: "gray" | "rgb" | "cmyk";
  components: number[];
}

/** RGB (0–1) approximation of a fill colour, for display. */
export function colorToRgb(color: FillColor): [number, number, number] {
  const c = color.components.map((v) => Math.min(1, Math.max(0, v)));
  if (color.space === "gray") return [c[0], c[0], c[0]];
  if (color.space === "rgb") return [c[0], c[1], c[2]];
  const [cy, m, y, k] = c;
  return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

export function colorToHex(color: FillColor): string {
  return `#${colorToRgb(color)
    .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToColor(hex: string): FillColor {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { space: "gray", components: [0] };
  const value = Number.parseInt(match[1], 16);
  return { space: "rgb", components: [(value >> 16) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255] };
}
