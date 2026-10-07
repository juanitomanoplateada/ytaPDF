import type { Matrix } from "../geometry";
import type { FillColor } from "./color";

/**
 * Plain data exchanged between the editor, the text worker and the export.
 * Coordinates are in the page's PDF user space unless stated otherwise.
 */

export type Point = [number, number];

/** A font of the page, with the characters it can draw again. */
export interface AnalyzedFont {
  /** Identifies the font object within the document. */
  key: string;
  /** PDF font name without the subset tag. */
  name: string;
  /** Family names to try in CSS, from the font name. */
  families: string[];
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  /** Key of a glyph drawn with this font: at export it locates the font object. */
  sample: string;
  /**
   * Characters this font can draw: text → [code, code length in bytes,
   * advance in thousandths of an em]. A code of -1 means "no glyph, only
   * spacing" (used for spaces in fonts without a space glyph).
   */
  glyphs: Record<string, [number, number, number]>;
  /** Width of a word space, in thousandths of an em. */
  space: number;
}

/** One character of the original text and how it looked. */
export interface AnalyzedChar {
  text: string;
  /** Index into the page's font table. */
  font: number;
  /** Em size in user space units. */
  size: number;
  color: FillColor;
  /** Text rise (superscript/subscript), in user space units. */
  rise: number;
}

/** A line or a paragraph that can be turned into editable text. */
export interface TextUnit {
  id: string;
  kind: "line" | "paragraph";
  /** Characters of each line. */
  lines: AnalyzedChar[][];
  /** What joins line i and i+1: a forced break, a space (soft wrap) or nothing. */
  joins: ("\n" | " " | "")[];
  align: "left" | "center" | "right" | "justify";
  /** Justified text whose last line also reaches the right edge (it continues elsewhere). */
  justifyLast: boolean;
  /** Start of the first baseline at the left edge of the box. */
  origin: Point;
  /** Unit vector along the baseline. */
  u: Point;
  /** Unit vector of the glyphs' vertical axis. */
  v: Point;
  /** Glyph width / height scale (horizontal scaling and stretched matrices). */
  hScale: number;
  /** Box width along the baseline. */
  width: number;
  /** Widest line measured with the font widths, in em-size units (no horizontal scaling). */
  naturalWidth: number;
  /** Distance between baselines (0 for a single line). */
  leading: number;
  /** Dominant em size. */
  size: number;
  /** Glyphs to erase, as "<path><op>:<from>-<to>" ranges. */
  erase: string[];
  /** Top-level operation after which the replacement is drawn. */
  insertAfter: string;
  alpha: number;
  renderMode: number;
  /** Outline of each line, for highlighting and hit testing. */
  quads: Point[][];
  editable: boolean;
  /** Why it cannot be edited, for the user. */
  reason?: string;
}

export interface PageTextAnalysis {
  fonts: AnalyzedFont[];
  lines: TextUnit[];
  paragraphs: TextUnit[];
  /** For each line, the paragraph that contains it (index), or -1. */
  paragraphOf: number[];
}

// ── Replacement specs ──────────────────────────────────────────────────────

/** The font a run is drawn with. */
export type RunFont =
  | { kind: "original"; sample: string; key: string }
  | {
      kind: "fallback";
      family: string;
      weight: string;
      style: string;
      /** Drawn instead of the original font, which lacks the characters. */
      substitute?: boolean;
    };

export interface RunGlyph {
  /** Text drawn (for fallback fonts) — or of the original glyph. */
  text: string;
  /** Original font: code, its byte length and advance (thousandths of an em). */
  code?: number;
  length?: number;
  width?: number;
  /** Baseline position in the run's local space (y up). */
  x: number;
  y: number;
}

export interface NativeRun {
  font: RunFont;
  size: number;
  color: FillColor;
  glyphs: RunGlyph[];
}

export interface NativeUnderline {
  color: FillColor;
  x: number;
  y: number;
  width: number;
  thickness: number;
}

/**
 * Everything needed to replace a piece of original text: what to erase and
 * what to draw instead, positioned in user space.
 */
export interface NativeSpec {
  id: string;
  erase: string[];
  insertAfter: string;
  /** Local space (y up) → page user space. */
  matrix: Matrix;
  /** Fill opacity to set, or undefined to keep the one of the original. */
  opacity?: number;
  renderMode: number;
  runs: NativeRun[];
  underlines: NativeUnderline[];
}
