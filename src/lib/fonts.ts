export type StandardFamilyId = "helvetica" | "times" | "courier";
export type EmbeddedFamilyId = "noto-sans" | "noto-serif";
export type FontFamilyId = StandardFamilyId | EmbeddedFamilyId;
export type FontVariant = "regular" | "bold" | "italic" | "boldItalic";

export interface FontFamilyOption {
  id: FontFamilyId;
  label: string;
  /**
   * CSS stack used on the canvas. Standard families list fonts metrically
   * compatible with the PDF standard font they map to; embedded families use
   * the exact font file that is embedded in the export.
   */
  css: string;
  /** Embedded families support any script the font covers (Latin, Greek, Cyrillic…). */
  embedded: boolean;
}

export const FONT_FAMILIES: FontFamilyOption[] = [
  {
    id: "helvetica",
    label: "Helvetica",
    css: 'Helvetica, Arial, "Liberation Sans", sans-serif',
    embedded: false,
  },
  {
    id: "times",
    label: "Times New Roman",
    css: '"Times New Roman", Times, "Liberation Serif", serif',
    embedded: false,
  },
  {
    id: "courier",
    label: "Courier",
    css: '"Courier New", Courier, "Liberation Mono", monospace',
    embedded: false,
  },
  {
    id: "noto-sans",
    label: "Noto Sans",
    css: '"Noto Sans", sans-serif',
    embedded: true,
  },
  {
    id: "noto-serif",
    label: "Noto Serif",
    css: '"Noto Serif", serif',
    embedded: true,
  },
];

export const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0];

function family(id: FontFamilyId): FontFamilyOption {
  return FONT_FAMILIES.find((f) => f.id === id) ?? DEFAULT_FONT_FAMILY;
}

export function familyFromCss(fontFamily: string | undefined): FontFamilyOption {
  if (!fontFamily) return DEFAULT_FONT_FAMILY;
  const exact = FONT_FAMILIES.find((f) => f.css === fontFamily);
  if (exact) return exact;
  const lower = fontFamily.toLowerCase();
  if (lower.includes("noto serif")) return family("noto-serif");
  if (lower.includes("noto")) return family("noto-sans");
  if (lower.includes("times") || (lower.includes("serif") && !lower.includes("sans"))) {
    return family("times");
  }
  if (lower.includes("courier") || lower.includes("mono")) return family("courier");
  return DEFAULT_FONT_FAMILY;
}

export function fontVariant(
  fontWeight: string | number | undefined,
  fontStyle: string | undefined,
): FontVariant {
  const bold = isBoldWeight(fontWeight);
  const italic = isItalicStyle(fontStyle);
  return bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";
}

/** How the export draws a text object: a standard PDF font or an embedded file. */
export type ResolvedFont =
  | { kind: "standard"; name: StandardFontName }
  | { kind: "embedded"; family: EmbeddedFamilyId; variant: FontVariant };

export function resolveFont(
  fontFamily: string | undefined,
  fontWeight: string | number | undefined,
  fontStyle: string | undefined,
): ResolvedFont {
  const option = familyFromCss(fontFamily);
  if (option.embedded) {
    return { kind: "embedded", family: option.id as EmbeddedFamilyId, variant: fontVariant(fontWeight, fontStyle) };
  }
  return { kind: "standard", name: standardFontFor(fontFamily, fontWeight, fontStyle) };
}

export function isBoldWeight(fontWeight: string | number | undefined): boolean {
  if (fontWeight === undefined) return false;
  if (typeof fontWeight === "number") return fontWeight >= 600;
  if (fontWeight === "bold" || fontWeight === "bolder") return true;
  const numeric = Number(fontWeight);
  return Number.isFinite(numeric) && numeric >= 600;
}

export function isItalicStyle(fontStyle: string | undefined): boolean {
  return fontStyle === "italic" || fontStyle === "oblique";
}

/**
 * Names of the standard 14 PDF fonts, matching pdf-lib's `StandardFonts` enum
 * values. Declared here so the editor does not load pdf-lib until export.
 */
export type StandardFontName =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique";

const STANDARD_FONTS: Record<FontFamilyId, [StandardFontName, StandardFontName, StandardFontName, StandardFontName]> = {
  // regular, bold, italic, bold italic
  helvetica: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  times: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  courier: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
  // Closest standard fonts, used for form field appearances that need one.
  "noto-sans": ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  "noto-serif": ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
};

export function standardFontFor(
  fontFamily: string | undefined,
  fontWeight: string | number | undefined,
  fontStyle: string | undefined,
): StandardFontName {
  const variants = STANDARD_FONTS[familyFromCss(fontFamily).id];
  const bold = isBoldWeight(fontWeight);
  const italic = isItalicStyle(fontStyle);
  return variants[(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/** Code points outside Latin-1 that Windows-1252 (WinAnsi) can still encode. */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Whether the standard 14 PDF fonts (WinAnsi encoding) can draw `char`. */
export function isWinAnsiChar(char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined) return false;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRAS.has(cp);
}

/** Readable stand-ins for common characters the standard fonts lack. */
const SUBSTITUTES: Record<string, string> = {
  "\t": "    ",
  "−": "-", // minus sign
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "―": "—",
  "←": "<-",
  "→": "->",
  "↔": "<->",
  "⇒": "=>",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≈": "~",
  "′": "'",
  "″": '"',
  "‛": "'",
  "‟": '"',
  "․": ".",
  "‧": "·",
  "∕": "/",
  "⁄": "/",
  // Letters without a Unicode decomposition to a WinAnsi base letter.
  "Ł": "L",
  "ł": "l",
  "Đ": "D",
  "đ": "d",
  "Ħ": "H",
  "ħ": "h",
  "ı": "i",
  "­": "",
  "​": "",
  "‌": "",
  "‍": "",
  "﻿": "",
};

const SPACE_LIKE = /[ -   　]/;

export interface SanitizeResult {
  text: string;
  /** Characters that had no equivalent and were replaced with "?". */
  unsupported: string[];
}

/**
 * Rewrites `text` so it only contains characters the font can encode.
 * `canEncode` defaults to the WinAnsi check; the export passes the real font.
 */
export function sanitizeForStandardFont(
  text: string,
  canEncode: (char: string) => boolean = isWinAnsiChar,
): SanitizeResult {
  const unsupported: string[] = [];
  let out = "";
  for (const char of text) {
    if (canEncode(char)) {
      out += char;
      continue;
    }
    if (char in SUBSTITUTES) {
      out += SUBSTITUTES[char];
      continue;
    }
    if (SPACE_LIKE.test(char)) {
      out += " ";
      continue;
    }
    // Compatibility forms (full-width letters, ligatures, superscripts...) and
    // letters with diacritics that WinAnsi lacks fall back to their base form.
    const decomposed = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (decomposed && decomposed !== char && [...decomposed].every(canEncode)) {
      out += decomposed;
      continue;
    }
    if (!unsupported.includes(char)) unsupported.push(char);
    out += "?";
  }
  return { text: out, unsupported };
}
