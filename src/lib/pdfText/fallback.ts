import { resolveFont, sanitizeForStandardFont } from "../fonts";
import type { DrawContext } from "../export/drawing";
import type { ApplyResources } from "./apply";

/**
 * Fonts for characters the document's own font cannot draw: the closest
 * standard font, or Noto when the text needs more than WinAnsi. Missing
 * characters are recorded on the draw context, like for any other text.
 */
export function fallbackResources(context: DrawContext): ApplyResources {
  return {
    async fallbackFont({ family, weight, style }) {
      const usable = await context.font(resolveFont(family || undefined, weight, style));
      return {
        font: usable.font,
        prepare(text) {
          const { text: out, unsupported } = sanitizeForStandardFont(text, usable.canEncode);
          for (const char of unsupported) (usable.embedded ? context.missingGlyphs : context.unsupportedChars).add(char);
          return out;
        },
      };
    },
  };
}
