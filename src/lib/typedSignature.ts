import type { Font, GlyphRun } from "@cantoo/fontkit";
import dancingScript from "@expo-google-fonts/dancing-script/600SemiBold/DancingScript_600SemiBold.ttf?url";
import greatVibes from "@expo-google-fonts/great-vibes/400Regular/GreatVibes_400Regular.ttf?url";
import caveat from "@expo-google-fonts/caveat/500Medium/Caveat_500Medium.ttf?url";

/**
 * Typed signatures are drawn from the outlines of a handwriting font, so they
 * stay vector shapes like a drawn signature. The fonts (OFL) are served from
 * this origin and only downloaded when the user types a signature.
 */
export const SIGNATURE_FONTS = [
  { id: "dancing", label: "Dancing Script", url: dancingScript },
  { id: "vibes", label: "Great Vibes", url: greatVibes },
  { id: "caveat", label: "Caveat", url: caveat },
] as const;

export type SignatureFontId = (typeof SIGNATURE_FONTS)[number]["id"];

/** The part of a fontkit font needed to lay out and outline text. */
export type OutlineFont = Pick<Font, "unitsPerEm" | "layout">;

const OPERATORS: Record<string, string> = {
  moveTo: "M",
  lineTo: "L",
  quadraticCurveTo: "Q",
  bezierCurveTo: "C",
  closePath: "Z",
};

/**
 * Outlines `text` as one SVG path (y down) whose bounding box starts at the
 * origin plus `padding`. `size` is the font size in path units. Returns null
 * for text without visible glyphs.
 */
export function textToPath(
  font: OutlineFont,
  text: string,
  size = 64,
  padding = 4,
): { path: string; width: number; height: number } | null {
  const run: GlyphRun = font.layout(text);
  const scale = size / font.unitsPerEm;
  const commands: { op: string; coords: number[] }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let penX = 0;
  let penY = 0;

  run.glyphs.forEach((glyph, i) => {
    const position = run.positions?.[i] ?? { xAdvance: glyph.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 };
    const originX = penX + position.xOffset;
    const originY = penY + position.yOffset;
    for (const { command, args } of glyph.path.commands) {
      const coords: number[] = [];
      for (let k = 0; k + 1 < args.length; k += 2) {
        const x = (originX + args[k]) * scale;
        // Font units grow upwards; the path is written y down like the canvas.
        const y = -(originY + args[k + 1]) * scale;
        coords.push(x, y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      commands.push({ op: OPERATORS[command] ?? "L", coords });
    }
    penX += position.xAdvance;
    penY += position.yAdvance;
  });

  if (!Number.isFinite(minX)) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  const dx = padding - minX;
  const dy = padding - minY;
  const path = commands
    .map(({ op, coords }) => [op, ...coords.map((value, i) => round(value + (i % 2 === 0 ? dx : dy)))].join(" "))
    .join(" ");
  return { path, width: round(maxX - minX + padding * 2), height: round(maxY - minY + padding * 2) };
}

const loaded = new Map<SignatureFontId, Promise<OutlineFont>>();

export function loadSignatureFont(id: SignatureFontId): Promise<OutlineFont> {
  let font = loaded.get(id);
  if (!font) {
    const entry = SIGNATURE_FONTS.find((f) => f.id === id) ?? SIGNATURE_FONTS[0];
    font = Promise.all([
      fetch(entry.url).then(async (response) => {
        if (!response.ok) throw new Error(`No se pudo cargar la fuente ${entry.label}.`);
        return new Uint8Array(await response.arrayBuffer());
      }),
      import("@cantoo/fontkit").then((module) => (module.default ?? module) as { create(bytes: Uint8Array): unknown }),
    ]).then(([bytes, fontkit]) => fontkit.create(bytes) as OutlineFont);
    font.catch(() => loaded.delete(id));
    loaded.set(id, font);
  }
  return font;
}
