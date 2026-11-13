/** How hard the export recompresses the document's JPEG images. */
export interface CompressionOptions {
  /** JPEG quality, 0–1. */
  quality: number;
  /** Resolution (pixels per inch at the size the image is shown) above which images are scaled down. */
  maxDpi: number;
}

export const COMPRESSION_PRESETS = {
  strong: { quality: 0.6, maxDpi: 110 },
  balanced: { quality: 0.75, maxDpi: 150 },
  light: { quality: 0.85, maxDpi: 220 },
} satisfies Record<string, CompressionOptions>;

export type CompressionLevel = keyof typeof COMPRESSION_PRESETS;
