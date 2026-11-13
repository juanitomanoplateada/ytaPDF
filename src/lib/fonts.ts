export type StandardFamilyId = "helvetica" | "times" | "courier";
export type EmbeddedFamilyId = "noto-sans" | "noto-serif";
export type FontFamilyId = StandardFamilyId | EmbeddedFamilyId;
export type FontVariant = "regular" | "bold" | "italic" | "boldItalic";
/** CSS font weight: a keyword such as "bold", or a number from 100 to 900. */
export type FontWeight = string | number;

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

/**
 * Fonts for scripts the families lack (Arabic, Chinese, Japanese, Korean).
 * They come after each family in its CSS stack, and the export uses the same
 * files for those characters, so the canvas and the PDF match.
 */
export type ScriptFontId = "noto-sans-arabic" | "noto-sans-sc" | "noto-sans-kr";

export const SCRIPT_FONT_NAMES: Record<ScriptFontId, string> = {
  "noto-sans-arabic": "Noto Sans Arabic",
  "noto-sans-sc": "Noto Sans SC",
  "noto-sans-kr": "Noto Sans KR",
};

const SCRIPT_STACK = '"Noto Sans Arabic", "Noto Sans SC", "Noto Sans KR"';

const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([from, to]) => cp >= from && cp <= to);
const ARABIC: [number, number][] = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x0870, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
];
const HANGUL: [number, number][] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
];
const CJK: [number, number][] = [
  [0x2e80, 0x2fdf],
  [0x3000, 0x30ff],
  [0x3100, 0x312f],
  [0x31a0, 0x31ff],
  [0x3200, 0x9fff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x3134f],
];

/** The script font that draws a character, or null for scripts the families cover. */
export function scriptFontFor(char: string): ScriptFontId | null {
  const cp = char.codePointAt(0) ?? 0;
  if (cp < 0x0600) return null;
  if (inRanges(cp, ARABIC)) return "noto-sans-arabic";
  if (inRanges(cp, HANGUL)) return "noto-sans-kr";
  if (inRanges(cp, CJK)) return "noto-sans-sc";
  return null;
}

/** Script fonts a text needs. */
export function scriptFontsIn(text: string): Set<ScriptFontId> {
  const ids = new Set<ScriptFontId>();
  for (const char of text) {
    const id = scriptFontFor(char);
    if (id) ids.add(id);
  }
  return ids;
}

/** Whether a character is written right to left (Arabic, Hebrew). */
export function isRtlChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
}

export const FONT_FAMILIES: FontFamilyOption[] = [
  {
    id: "helvetica",
    label: "Helvetica",
    css: `Helvetica, Arial, "Liberation Sans", ${SCRIPT_STACK}, sans-serif`,
    embedded: false,
  },
  {
    id: "times",
    label: "Times New Roman",
    css: `"Times New Roman", Times, "Liberation Serif", ${SCRIPT_STACK}, serif`,
    embedded: false,
  },
  {
    id: "courier",
    label: "Courier",
    css: `"Courier New", Courier, "Liberation Mono", ${SCRIPT_STACK}, monospace`,
    embedded: false,
  },
  {
    id: "noto-sans",
    label: "Noto Sans",
    css: `"Noto Sans", ${SCRIPT_STACK}, sans-serif`,
    embedded: true,
  },
  {
    id: "noto-serif",
    label: "Noto Serif",
    css: `"Noto Serif", ${SCRIPT_STACK}, serif`,
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
  // The script fonts at the end of every stack say nothing about the family.
  const lower = fontFamily.replace(SCRIPT_STACK, "").toLowerCase();
  if (lower.includes("noto serif")) return family("noto-serif");
  if (lower.includes("noto")) return family("noto-sans");
  if (lower.includes("times") || (lower.includes("serif") && !lower.includes("sans"))) {
    return family("times");
  }
  if (lower.includes("courier") || lower.includes("mono")) return family("courier");
  return DEFAULT_FONT_FAMILY;
}

export function fontVariant(
  fontWeight: FontWeight | undefined,
  fontStyle: string | undefined,
): FontVariant {
  const bold = isBoldWeight(fontWeight);
  const italic = isItalicStyle(fontStyle);
  if (bold && italic) return "boldItalic";
  if (bold) return "bold";
  return italic ? "italic" : "regular";
}

/** How the export draws a text object: a standard PDF font or an embedded file. */
export type ResolvedFont =
  | { kind: "standard"; name: StandardFontName }
  | { kind: "embedded"; family: EmbeddedFamilyId; variant: FontVariant };

export function resolveFont(
  fontFamily: string | undefined,
  fontWeight: FontWeight | undefined,
  fontStyle: string | undefined,
): ResolvedFont {
  const option = familyFromCss(fontFamily);
  if (option.embedded) {
    return { kind: "embedded", family: option.id as EmbeddedFamilyId, variant: fontVariant(fontWeight, fontStyle) };
  }
  return { kind: "standard", name: standardFontFor(fontFamily, fontWeight, fontStyle) };
}

export function isBoldWeight(fontWeight: FontWeight | undefined): boolean {
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
  fontWeight: FontWeight | undefined,
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
    const decomposed = char.normalize("NFKD").replaceAll(/[̀-ͯ]/g, "");
    if (decomposed && decomposed !== char && [...decomposed].every(canEncode)) {
      out += decomposed;
      continue;
    }
    if (!unsupported.includes(char)) unsupported.push(char);
    out += "?";
  }
  return { text: out, unsupported };
}
