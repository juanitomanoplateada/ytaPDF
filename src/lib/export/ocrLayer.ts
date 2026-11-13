import {
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  type PDFFont,
  type PDFName,
  type PDFOperator,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { Point } from "../polygon";

/**
 * Text recognised by OCR, written over the page as invisible text (render
 * mode 3, as scanners do): viewers do not paint it, but it can be searched,
 * selected and copied, and each word sits over its picture.
 */

export interface PlacedWord {
  text: string;
  /** Bottom-left, bottom-right, top-right, top-left in the page's user space. */
  quad: Point[];
}

/** Font size as a share of the word box's height, and where the baseline sits in it. */
const SIZE_OF_HEIGHT = 0.82;
const BASELINE_OF_HEIGHT = 0.2;

export function invisibleTextOperators(
  words: PlacedWord[],
  font: PDFFont,
  fontKey: PDFName | string,
  canEncode: (char: string) => boolean,
): PDFOperator[] {
  const operators: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let count = 0;
  for (const word of words) {
    const text = Array.from(word.text, (char) => (canEncode(char) ? char : "?")).join("");
    const [bl, br, , tl] = word.quad;
    const along: Point = [br[0] - bl[0], br[1] - bl[1]];
    const up: Point = [tl[0] - bl[0], tl[1] - bl[1]];
    const width = Math.hypot(...along);
    const height = Math.hypot(...up);
    if (!text.trim() || width <= 0 || height <= 0) continue;
    const u: Point = [along[0] / width, along[1] / width];
    const v: Point = [up[0] / height, up[1] / height];
    const size = height * SIZE_OF_HEIGHT;
    const natural = font.widthOfTextAtSize(text, size);
    if (natural <= 0) continue;
    const origin: Point = [bl[0] + v[0] * height * BASELINE_OF_HEIGHT, bl[1] + v[1] * height * BASELINE_OF_HEIGHT];
    operators.push(
      setFontAndSize(fontKey, size),
      setCharacterSqueeze(Math.max(1, Math.min(1000, (width / natural) * 100))),
      setTextMatrix(u[0], u[1], v[0], v[1], origin[0], origin[1]),
      showText(font.encodeText(`${text} `)),
    );
    count++;
  }
  operators.push(endText(), popGraphicsState());
  return count > 0 ? operators : [];
}

/** Writes recognised words onto a page as invisible text. Returns how many. */
export function addInvisibleText(
  page: PDFPage,
  words: PlacedWord[],
  font: PDFFont,
  canEncode: (char: string) => boolean,
): number {
  if (words.length === 0) return 0;
  const key = page.node.newFontDictionary(font.name, font.ref);
  const operators = invisibleTextOperators(words, font, key, canEncode);
  if (operators.length === 0) return 0;
  page.pushOperators(...operators);
  return words.length;
}
