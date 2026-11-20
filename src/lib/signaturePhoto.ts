/**
 * Turns a photo of a signature on paper into ink on a transparent
 * background: light pixels (the paper) disappear, dark ones (the ink) keep a
 * single colour, and the result is cropped to the ink.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface InkResult extends Pixels {
  /** False when no pixel was dark enough to count as ink. */
  found: boolean;
}

/** Perceived lightness of a pixel, 0 (black) to 255 (white). */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The paper's lightness, estimated as a high percentile of the image: most of
 * a signature photo is paper, and the percentile ignores glare.
 */
export function paperLevel(pixels: Pixels): number {
  const histogram = new Uint32Array(256);
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) histogram[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
  const total = data.length / 4;
  let seen = 0;
  // Every pixel is at or below 255, so the last level needs no counting.
  for (let level = 0; level < 255; level++) {
    seen += histogram[level];
    if (seen >= total * 0.6) return level;
  }
  return 255;
}

/**
 * `sensitivity` (0–1) sets how much darker than the paper a pixel must be to
 * count as ink: higher keeps fainter strokes (and more shadows).
 */
export function extractInk(pixels: Pixels, color: { r: number; g: number; b: number }, sensitivity = 0.5): InkResult {
  const { data, width, height } = pixels;
  const paper = paperLevel(pixels);
  // Pixels lighter than `cut` are paper; between `full` and `cut` they fade.
  const cut = paper * (0.55 + sensitivity * 0.4);
  const full = cut * 0.6;
  const out = new Uint8ClampedArray(data.length);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const level = luminance(data[i], data[i + 1], data[i + 2]);
      if (level >= cut || data[i + 3] === 0) continue;
      const alpha = level <= full ? 1 : (cut - level) / (cut - full);
      out[i] = color.r;
      out[i + 1] = color.g;
      out[i + 2] = color.b;
      out[i + 3] = Math.round(alpha * (data[i + 3] / 255) * 255);
      if (out[i + 3] < 24) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < 0) return { data: out, width, height, found: false };
  const pad = Math.round(Math.max(width, height) * 0.01);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const cropWidth = Math.min(width, maxX + pad + 1) - left;
  const cropHeight = Math.min(height, maxY + pad + 1) - top;
  const cropped = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const from = ((top + y) * width + left) * 4;
    cropped.set(out.subarray(from, from + cropWidth * 4), y * cropWidth * 4);
  }
  return { data: cropped, width: cropWidth, height: cropHeight, found: true };
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000";
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}
