import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";
import { applyToPoint, IDENTITY, multiply, type Matrix } from "../geometry";
import type { PdfFont, FontCache } from "./fonts";
import { isName, isString, parseContent, type Operand, type Operation } from "./lexer";
import { arrayOf, dictOf, nameOf, numberOf, numbersOf, resolve, streamBytes } from "./pdfObjects";

import type { FillColor } from "./color";

export type { FillColor };

/** One drawn character code, with everything needed to find, erase or imitate it. */
export interface Glyph {
  /** Stable identifier: `<form path><operation>:<index within the operation>`. */
  key: string;
  /** "" for the page's own content, "12/" for a form drawn by operation 12, and so on. */
  path: string;
  op: number;
  index: number;
  code: number;
  /** Bytes the code takes in the string. */
  length: number;
  unicode: string | undefined;
  font: PdfFont;
  /** The font as found in the resources (a reference or an inline dictionary). */
  fontObject: PDFObject;
  size: number;
  /** Horizontal scaling as a fraction (Tz / 100). */
  hScale: number;
  charSpacing: number;
  wordSpacing: number;
  rise: number;
  renderMode: number;
  textMatrix: Matrix;
  ctm: Matrix;
  /** Advance in unscaled text space, spacing included. */
  advance: number;
  /** The glyph's own width in unscaled text space. */
  width: number;
  color: FillColor;
  alpha: number;
  /** Top-level operation after which a replacement can be drawn ("end" if none). */
  insertAfter: string;
  /** Text object (BT … ET) the glyph belongs to, numbered across the page. */
  textObject: number;
  vertical: boolean;
}

/** A form XObject drawn by the page, as read for one invocation. */
export interface FormInvocation {
  path: string;
  stream: PDFStream;
  bytes: Uint8Array;
  operations: Operation[];
  resources: PDFDict | undefined;
}

export interface PageContent {
  bytes: Uint8Array;
  operations: Operation[];
  glyphs: Glyph[];
  /** CTM after each top-level operation, when requested. */
  ctmAfter: Matrix[];
  forms: Map<string, FormInvocation>;
  resources: PDFDict | undefined;
  /** False if part of the content could not be decoded (unsupported filter). */
  complete: boolean;
}

interface TextState {
  font: PdfFont | undefined;
  fontObject: PDFObject | undefined;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

interface GraphicsState {
  ctm: Matrix;
  text: TextState;
  color: FillColor;
  colorSpace: FillColor["space"] | "other";
  alpha: number;
}

const BLACK: FillColor = { space: "gray", components: [0] };
const MAX_FORM_DEPTH = 8;

/** Concatenates a page's content streams, as viewers read them. */
export function pageContentBytes(page: PDFPage): { bytes: Uint8Array; complete: boolean } {
  const { context } = page.doc;
  const contents = resolve(context, page.node.get(PDFName.of("Contents")));
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const item = resolve(context, contents.get(i));
      if (item instanceof PDFStream) streams.push(item);
    }
  }
  const parts: Uint8Array[] = [];
  let complete = true;
  for (const stream of streams) {
    const bytes = streamBytes(stream);
    if (bytes) parts.push(bytes, NEWLINE);
    else complete = false;
  }
  return { bytes: concat(parts), complete };
}

const NEWLINE = Uint8Array.of(0x0a);

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Reads a page's content, following text state, colour and transforms, and
 * returns every glyph it draws, including those inside form XObjects.
 */
export function interpretPage(page: PDFPage, fonts: FontCache, options: { trackCtm?: boolean } = {}): PageContent {
  const { context } = page.doc;
  const { bytes, complete } = pageContentBytes(page);
  const resources = page.node.Resources();
  const operations = parseContent(bytes);
  const interpreter = new Interpreter(context, fonts, options.trackCtm ?? false);
  interpreter.run(operations, resources, "", newState(IDENTITY), 0, new Set());
  return {
    bytes,
    operations,
    glyphs: interpreter.glyphs,
    ctmAfter: interpreter.ctmAfter,
    forms: interpreter.forms,
    resources,
    complete: complete && interpreter.complete,
  };
}

function newState(ctm: Matrix): GraphicsState {
  return {
    ctm,
    text: {
      font: undefined,
      fontObject: undefined,
      size: 0,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      leading: 0,
      rise: 0,
      renderMode: 0,
    },
    color: BLACK,
    colorSpace: "gray",
    alpha: 1,
  };
}

function cloneState(state: GraphicsState): GraphicsState {
  return { ...state, text: { ...state.text } };
}

const num = (value: Operand | undefined) => (typeof value === "number" ? value : 0);

class Interpreter {
  readonly glyphs: Glyph[] = [];
  readonly ctmAfter: Matrix[] = [];
  readonly forms = new Map<string, FormInvocation>();
  complete = true;
  #textObjects = 0;

  constructor(
    private readonly context: PDFContext,
    private readonly fonts: FontCache,
    private readonly trackCtm: boolean,
  ) {}

  run(
    operations: Operation[],
    resources: PDFDict | undefined,
    path: string,
    initial: GraphicsState,
    depth: number,
    visiting: Set<string>,
  ): void {
    const top = path === "";
    const stack: GraphicsState[] = [];
    let state = initial;
    let tm: Matrix = [...IDENTITY];
    let tlm: Matrix = [...IDENTITY];
    let pending: Glyph[] = [];
    let textObject = -1;

    const fontResource = (name: string): PDFObject | undefined => {
      const fontDict = dictOf(this.context, resources?.get(PDFName.of("Font")));
      return fontDict?.get(PDFName.of(name));
    };

    const show = (opIndex: number, items: Operand[], firstIndex: number): number => {
      let index = firstIndex;
      const { text } = state;
      const font = text.font;
      for (const item of items) {
        if (typeof item === "number") {
          const tx = (-item / 1000) * text.size * text.hScale;
          if (font?.vertical) tm = multiply(tm, [1, 0, 0, 1, 0, (-item / 1000) * text.size]);
          else tm = multiply(tm, [1, 0, 0, 1, tx, 0]);
          continue;
        }
        if (!isString(item) || !font || !text.fontObject) continue;
        for (const read of font.readCodes(item.bytes)) {
          const w0 = font.width(read.code) * font.scale;
          const spacing = text.charSpacing + (read.length === 1 && read.code === 32 ? text.wordSpacing : 0);
          const glyph: Glyph = {
            key: `${path}${opIndex}:${index}`,
            path,
            op: opIndex,
            index,
            code: read.code,
            length: read.length,
            unicode: font.unicode(read.code),
            font,
            fontObject: text.fontObject,
            size: text.size,
            hScale: text.hScale,
            charSpacing: text.charSpacing,
            wordSpacing: text.wordSpacing,
            rise: text.rise,
            renderMode: text.renderMode,
            textMatrix: tm,
            ctm: state.ctm,
            advance: font.vertical ? 0 : (w0 * text.size + spacing) * text.hScale,
            width: w0 * text.size * text.hScale,
            color: state.color,
            alpha: state.alpha,
            insertAfter: top ? "end" : (this.#topOp ?? "end"),
            textObject: this.#topTextObject ?? textObject,
            vertical: font.vertical,
          };
          this.glyphs.push(glyph);
          if (top) pending.push(glyph);
          if (font.vertical) {
            tm = multiply(tm, [1, 0, 0, 1, 0, -(text.size + spacing)]);
          } else {
            tm = multiply(tm, [1, 0, 0, 1, glyph.advance, 0]);
          }
          index++;
        }
      }
      return index;
    };

    const nextLine = (tx: number, ty: number) => {
      tlm = multiply(tlm, [1, 0, 0, 1, tx, ty]);
      tm = [...tlm];
    };

    for (let i = 0; i < operations.length; i++) {
      const { op, operands } = operations[i];
      if (top) this.#topOp = String(i);
      switch (op) {
        case "q":
          stack.push(cloneState(state));
          break;
        case "Q":
          if (stack.length > 0) state = stack.pop()!;
          break;
        case "cm":
          if (operands.length >= 6) {
            state = { ...state, ctm: multiply(state.ctm, operands.slice(0, 6).map(num) as Matrix) };
          }
          break;
        case "BT":
          tm = [...IDENTITY];
          tlm = [...IDENTITY];
          textObject = this.#textObjects++;
          break;
        case "ET":
          if (top) for (const glyph of pending) glyph.insertAfter = String(i);
          pending = [];
          break;
        case "Tf": {
          const name = operands[0];
          const object = isName(name) ? fontResource(name.value) : undefined;
          state.text.font = object ? this.fonts.get(object) : undefined;
          state.text.fontObject = object;
          state.text.size = num(operands[1]);
          break;
        }
        case "Tc":
          state.text.charSpacing = num(operands[0]);
          break;
        case "Tw":
          state.text.wordSpacing = num(operands[0]);
          break;
        case "Tz":
          state.text.hScale = num(operands[0]) / 100;
          break;
        case "TL":
          state.text.leading = num(operands[0]);
          break;
        case "Ts":
          state.text.rise = num(operands[0]);
          break;
        case "Tr":
          state.text.renderMode = num(operands[0]);
          break;
        case "Td":
          nextLine(num(operands[0]), num(operands[1]));
          break;
        case "TD":
          state.text.leading = -num(operands[1]);
          nextLine(num(operands[0]), num(operands[1]));
          break;
        case "Tm":
          tlm = operands.slice(0, 6).map(num) as Matrix;
          tm = [...tlm];
          break;
        case "T*":
          nextLine(0, -state.text.leading);
          break;
        case "Tj":
          show(i, [operands[0] ?? []], 0);
          break;
        case "TJ":
          show(i, Array.isArray(operands[0]) ? operands[0] : [], 0);
          break;
        case "'":
          nextLine(0, -state.text.leading);
          show(i, [operands[0] ?? []], 0);
          break;
        case '"':
          state.text.wordSpacing = num(operands[0]);
          state.text.charSpacing = num(operands[1]);
          nextLine(0, -state.text.leading);
          show(i, [operands[2] ?? []], 0);
          break;
        case "g":
          state.colorSpace = "gray";
          state.color = { space: "gray", components: [num(operands[0])] };
          break;
        case "rg":
          state.colorSpace = "rgb";
          state.color = { space: "rgb", components: operands.slice(0, 3).map(num) };
          break;
        case "k":
          state.colorSpace = "cmyk";
          state.color = { space: "cmyk", components: operands.slice(0, 4).map(num) };
          break;
        case "cs": {
          const name = operands[0];
          state.colorSpace = isName(name) ? this.#colorSpace(name.value, resources) : "other";
          state.color = initialColor(state.colorSpace);
          break;
        }
        case "sc":
        case "scn":
          state.color = colorFrom(state.colorSpace, operands.filter((o): o is number => typeof o === "number"));
          break;
        case "gs": {
          const name = operands[0];
          if (isName(name)) this.#applyExtGState(name.value, resources, state);
          break;
        }
        case "Do": {
          const name = operands[0];
          if (isName(name)) this.#drawForm(name.value, resources, `${path}${i}/`, state, depth, visiting);
          break;
        }
      }
      if (top && this.trackCtm) this.ctmAfter.push(state.ctm);
    }
    if (top) this.#topOp = undefined;
  }

  /** Top-level operation and text object currently being executed (for forms). */
  #topOp: string | undefined;
  #topTextObject: number | undefined;

  #colorSpace(name: string, resources: PDFDict | undefined): FillColor["space"] | "other" {
    if (name === "DeviceGray" || name === "G" || name === "CalGray") return "gray";
    if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return "rgb";
    if (name === "DeviceCMYK" || name === "CMYK") return "cmyk";
    const spaces = dictOf(this.context, resources?.get(PDFName.of("ColorSpace")));
    const value = resolve(this.context, spaces?.get(PDFName.of(name)));
    if (value instanceof PDFName) return this.#colorSpace(value.decodeText(), undefined);
    const array = value instanceof PDFArray ? value : undefined;
    if (!array) return "other";
    const family = nameOf(this.context, array.get(0));
    if (family === "ICCBased") {
      const stream = resolve(this.context, array.get(1));
      const n = stream instanceof PDFStream ? numberOf(this.context, stream.dict.get(PDFName.of("N")), 3) : 3;
      return n === 1 ? "gray" : n === 4 ? "cmyk" : "rgb";
    }
    if (family === "CalGray") return "gray";
    if (family === "CalRGB" || family === "Lab") return "rgb";
    return "other";
  }

  #applyExtGState(name: string, resources: PDFDict | undefined, state: GraphicsState): void {
    const states = dictOf(this.context, resources?.get(PDFName.of("ExtGState")));
    const gs = dictOf(this.context, states?.get(PDFName.of(name)));
    if (!gs) return;
    const alpha = resolve(this.context, gs.get(PDFName.of("ca")));
    if (alpha !== undefined) state.alpha = numberOf(this.context, alpha, 1);
    const font = arrayOf(this.context, gs.get(PDFName.of("Font")));
    if (font && font.size() >= 2) {
      const object = font.get(0);
      state.text.font = this.fonts.get(object);
      state.text.fontObject = object;
      state.text.size = numberOf(this.context, font.get(1));
    }
  }

  #drawForm(
    name: string,
    resources: PDFDict | undefined,
    path: string,
    state: GraphicsState,
    depth: number,
    visiting: Set<string>,
  ): void {
    if (depth >= MAX_FORM_DEPTH) return;
    const xobjects = dictOf(this.context, resources?.get(PDFName.of("XObject")));
    const raw = xobjects?.get(PDFName.of(name));
    const stream = resolve(this.context, raw);
    if (!(stream instanceof PDFStream)) return;
    if (nameOf(this.context, stream.dict.get(PDFName.of("Subtype"))) !== "Form") return;
    const id = raw instanceof PDFRef ? raw.toString() : path;
    if (visiting.has(id)) return;

    const bytes = streamBytes(stream);
    if (!bytes) {
      this.complete = false;
      return;
    }
    const matrix = numbersOf(this.context, stream.dict.get(PDFName.of("Matrix")));
    const formResources = dictOf(this.context, stream.dict.get(PDFName.of("Resources"))) ?? resources;
    const operations = parseContent(bytes);
    this.forms.set(path, { path, stream, bytes, operations, resources: formResources });

    const inner = cloneState(state);
    if (matrix && matrix.length === 6) inner.ctm = multiply(state.ctm, matrix as Matrix);
    const outerTextObject = this.#topTextObject;
    if (depth === 0) this.#topTextObject = this.#textObjects++;
    visiting.add(id);
    this.run(operations, formResources, path, inner, depth + 1, visiting);
    visiting.delete(id);
    if (depth === 0) this.#topTextObject = outerTextObject;
  }
}

function initialColor(space: GraphicsState["colorSpace"]): FillColor {
  if (space === "rgb") return { space: "rgb", components: [0, 0, 0] };
  if (space === "cmyk") return { space: "cmyk", components: [0, 0, 0, 1] };
  return BLACK;
}

function colorFrom(space: GraphicsState["colorSpace"], values: number[]): FillColor {
  if (space === "gray" && values.length >= 1) return { space: "gray", components: [values[0]] };
  if (space === "rgb" && values.length >= 3) return { space: "rgb", components: values.slice(0, 3) };
  if (space === "cmyk" && values.length >= 4) return { space: "cmyk", components: values.slice(0, 4) };
  // Separations and other spaces: a single tint reads as a shade of grey.
  if (values.length === 1) return { space: "gray", components: [1 - Math.min(1, Math.max(0, values[0]))] };
  return BLACK;
}

// ── Geometry ───────────────────────────────────────────────────────────────

/** Glyph space (1 = font size) → page user space, without the text rise. */
export function baselineMatrix(glyph: Glyph): Matrix {
  return multiply(glyph.ctm, multiply(glyph.textMatrix, [glyph.size * glyph.hScale, 0, 0, glyph.size, 0, 0]));
}

/** Glyph space (1 = font size) → page user space, as drawn (rise included). */
export function renderingMatrix(glyph: Glyph): Matrix {
  return multiply(glyph.ctm, multiply(glyph.textMatrix, [glyph.size * glyph.hScale, 0, 0, glyph.size, 0, glyph.rise]));
}

/** Corners of the box a glyph occupies on the page (user space). */
export function glyphQuad(glyph: Glyph): [number, number][] {
  const m = renderingMatrix(glyph);
  const em = glyph.size * glyph.hScale;
  const w = em !== 0 ? glyph.width / em : 0;
  const { ascent, descent } = glyph.font;
  return [
    applyToPoint(m, 0, descent),
    applyToPoint(m, w, descent),
    applyToPoint(m, w, ascent),
    applyToPoint(m, 0, ascent),
  ];
}
