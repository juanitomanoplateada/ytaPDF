import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { applyToPoint, IDENTITY, multiply, type Matrix } from "../geometry";
import type { CodeRead } from "./cmap";
import type { PdfFont, FontCache } from "./fonts";
import { isName, isString, parseContent, type Operand, type Operation } from "./lexer";
import { arrayOf, dictOf, nameOf, numberOf, numbersOf, resolve, streamBytes } from "./pdfObjects";

import type { FillColor } from "./color";

export type { FillColor } from "./color";

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

/** Something painted that is not text: a filled or stroked path, an image or a shading. */
export interface PaintedArea {
  /** `<form path><operation>` of the painting operation. */
  key: string;
  kind: "path" | "image" | "shading";
  /** Corners of what is painted, in page user space: the path's points or the image's square. */
  points: [number, number][];
  /** Name of the image XObject drawn by `Do` (undefined for inline images and paths). */
  name?: string;
  /** The image XObject itself, when it is an indirect object. */
  ref?: PDFRef;
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
  /** Paths, images and shadings, when requested. */
  paints: PaintedArea[];
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
export function interpretPage(
  page: PDFPage,
  fonts: FontCache,
  options: { trackCtm?: boolean; trackPaints?: boolean } = {},
): PageContent {
  const { context } = page.doc;
  const { bytes, complete } = pageContentBytes(page);
  const resources = page.node.Resources();
  const operations = parseContent(bytes);
  const interpreter = new Interpreter(context, fonts, options.trackCtm ?? false, options.trackPaints ?? false);
  interpreter.run(operations, resources, "", newState(IDENTITY), 0, new Set());
  return {
    bytes,
    operations,
    glyphs: interpreter.glyphs,
    ctmAfter: interpreter.ctmAfter,
    paints: interpreter.paints,
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
  readonly paints: PaintedArea[] = [];
  readonly forms = new Map<string, FormInvocation>();
  complete = true;
  /** Text objects (BT … ET, and forms drawn by the page) numbered across the page. */
  textObjects = 0;
  /** Top-level operation and text object currently being executed (for forms). */
  topOp: string | undefined;
  topTextObject: number | undefined;

  constructor(
    readonly context: PDFContext,
    readonly fonts: FontCache,
    private readonly trackCtm: boolean,
    readonly trackPaints: boolean,
  ) {}

  run(
    operations: Operation[],
    resources: PDFDict | undefined,
    path: string,
    initial: GraphicsState,
    depth: number,
    visiting: Set<string>,
  ): void {
    const run = new ContentRun(this, { resources, path, depth, visiting }, initial);
    for (let i = 0; i < operations.length; i++) {
      const { op, operands } = operations[i];
      if (run.top) this.topOp = String(i);
      OPERATORS.get(op)?.(run, operands, i);
      if (run.top && this.trackCtm) this.ctmAfter.push(run.state.ctm);
    }
    if (run.top) this.topOp = undefined;
  }

  colorSpace(name: string, resources: PDFDict | undefined): FillColor["space"] | "other" {
    if (name === "DeviceGray" || name === "G" || name === "CalGray") return "gray";
    if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return "rgb";
    if (name === "DeviceCMYK" || name === "CMYK") return "cmyk";
    const spaces = dictOf(this.context, resources?.get(PDFName.of("ColorSpace")));
    const value = resolve(this.context, spaces?.get(PDFName.of(name)));
    if (value instanceof PDFName) return this.colorSpace(value.decodeText(), undefined);
    if (!(value instanceof PDFArray)) return "other";
    const family = nameOf(this.context, value.get(0));
    if (family === "ICCBased") {
      const stream = resolve(this.context, value.get(1));
      const n = stream instanceof PDFStream ? numberOf(this.context, stream.dict.get(PDFName.of("N")), 3) : 3;
      if (n === 1) return "gray";
      return n === 4 ? "cmyk" : "rgb";
    }
    if (family === "CalGray") return "gray";
    if (family === "CalRGB" || family === "Lab") return "rgb";
    return "other";
  }

  /** The image XObject called `name`, or null when it is not an image. */
  image(name: string, resources: PDFDict | undefined): { ref: PDFRef | undefined } | null {
    const xobjects = dictOf(this.context, resources?.get(PDFName.of("XObject")));
    const raw = xobjects?.get(PDFName.of(name));
    const stream = resolve(this.context, raw);
    if (!(stream instanceof PDFStream) || nameOf(this.context, stream.dict.get(PDFName.of("Subtype"))) !== "Image")
      return null;
    return { ref: raw instanceof PDFRef ? raw : undefined };
  }

  applyExtGState(name: string, resources: PDFDict | undefined, state: GraphicsState): void {
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

  drawForm(name: string, scope: RunScope, path: string, state: GraphicsState): void {
    const { resources, depth, visiting } = scope;
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
    if (matrix?.length === 6) inner.ctm = multiply(state.ctm, matrix as Matrix);
    const outerTextObject = this.topTextObject;
    if (depth === 0) this.topTextObject = this.textObjects++;
    visiting.add(id);
    this.run(operations, formResources, path, inner, depth + 1, visiting);
    visiting.delete(id);
    if (depth === 0) this.topTextObject = outerTextObject;
  }
}

/** Where a content stream runs: its resources, its form path and how deep in forms. */
interface RunScope {
  resources: PDFDict | undefined;
  /** "" for the page's own content, "12/" for a form drawn by operation 12, and so on. */
  path: string;
  depth: number;
  visiting: Set<string>;
}

/** The state of one content stream while it is read: graphics, text and the path being built. */
class ContentRun {
  readonly stack: GraphicsState[] = [];
  readonly top: boolean;
  state: GraphicsState;
  tm: Matrix = [...IDENTITY];
  tlm: Matrix = [...IDENTITY];
  /** Glyphs of the current text object (top level), whose insertion point is its ET. */
  pending: Glyph[] = [];
  textObject = -1;
  /** Points of the path being built, already in page user space. */
  pathPoints: [number, number][] = [];

  constructor(
    readonly interpreter: Interpreter,
    readonly scope: RunScope,
    initial: GraphicsState,
  ) {
    this.top = scope.path === "";
    this.state = initial;
  }

  key(i: number): string {
    return `${this.scope.path}${i}`;
  }

  addPoints(values: number[]): void {
    if (!this.interpreter.trackPaints) return;
    for (let k = 0; k + 1 < values.length; k += 2)
      this.pathPoints.push(applyToPoint(this.state.ctm, values[k], values[k + 1]));
  }

  unitSquare(): [number, number][] {
    const { ctm } = this.state;
    return [applyToPoint(ctm, 0, 0), applyToPoint(ctm, 1, 0), applyToPoint(ctm, 1, 1), applyToPoint(ctm, 0, 1)];
  }

  paint(area: PaintedArea): void {
    if (this.interpreter.trackPaints) this.interpreter.paints.push(area);
  }

  /** A path painting operator: the path is recorded (when it has points) and ends. */
  paintPath(i: number): void {
    if (this.pathPoints.length > 0) this.paint({ key: this.key(i), kind: "path", points: this.pathPoints });
    this.pathPoints = [];
  }

  setFont(name: Operand | undefined, size: Operand | undefined): void {
    const fontDict = dictOf(this.interpreter.context, this.scope.resources?.get(PDFName.of("Font")));
    const object = isName(name) ? fontDict?.get(PDFName.of(name.value)) : undefined;
    this.state.text.font = object ? this.interpreter.fonts.get(object) : undefined;
    this.state.text.fontObject = object;
    this.state.text.size = num(size);
  }

  nextLine(tx: number, ty: number): void {
    this.tlm = multiply(this.tlm, [1, 0, 0, 1, tx, ty]);
    this.tm = [...this.tlm];
  }

  beginText(): void {
    this.tm = [...IDENTITY];
    this.tlm = [...IDENTITY];
    this.textObject = this.interpreter.textObjects++;
  }

  endText(i: number): void {
    if (this.top) for (const glyph of this.pending) glyph.insertAfter = String(i);
    this.pending = [];
  }

  /** Shows strings and adjustments (TJ arrays and the other text operators). */
  show(opIndex: number, items: Operand[]): void {
    let index = 0;
    for (const item of items) {
      if (typeof item === "number") this.#adjust(item);
      else if (isString(item)) index = this.#showString(opIndex, item.bytes, index);
    }
  }

  /** A number in a TJ array moves the next glyph back (or down, in vertical text). */
  #adjust(amount: number): void {
    const { text } = this.state;
    if (text.font?.vertical) this.tm = multiply(this.tm, [1, 0, 0, 1, 0, (-amount / 1000) * text.size]);
    else this.tm = multiply(this.tm, [1, 0, 0, 1, (-amount / 1000) * text.size * text.hScale, 0]);
  }

  #showString(opIndex: number, bytes: Uint8Array, firstIndex: number): number {
    const { text } = this.state;
    const font = text.font;
    if (!font || !text.fontObject) return firstIndex;
    let index = firstIndex;
    for (const read of font.readCodes(bytes)) {
      const spacing = text.charSpacing + (read.length === 1 && read.code === 32 ? text.wordSpacing : 0);
      const glyph = this.#glyph(opIndex, index, read, font, text.fontObject, spacing);
      this.interpreter.glyphs.push(glyph);
      if (this.top) this.pending.push(glyph);
      const move: Matrix = font.vertical ? [1, 0, 0, 1, 0, -(text.size + spacing)] : [1, 0, 0, 1, glyph.advance, 0];
      this.tm = multiply(this.tm, move);
      index++;
    }
    return index;
  }

  #glyph(opIndex: number, index: number, read: CodeRead, font: PdfFont, fontObject: PDFObject, spacing: number): Glyph {
    const { text } = this.state;
    const { path } = this.scope;
    const w0 = font.width(read.code) * font.scale;
    return {
      key: `${path}${opIndex}:${index}`,
      path,
      op: opIndex,
      index,
      code: read.code,
      length: read.length,
      unicode: font.unicode(read.code),
      font,
      fontObject,
      size: text.size,
      hScale: text.hScale,
      charSpacing: text.charSpacing,
      wordSpacing: text.wordSpacing,
      rise: text.rise,
      renderMode: text.renderMode,
      textMatrix: this.tm,
      ctm: this.state.ctm,
      advance: font.vertical ? 0 : (w0 * text.size + spacing) * text.hScale,
      width: w0 * text.size * text.hScale,
      color: this.state.color,
      alpha: this.state.alpha,
      insertAfter: this.top ? "end" : (this.interpreter.topOp ?? "end"),
      textObject: this.interpreter.topTextObject ?? this.textObject,
      vertical: font.vertical,
    };
  }

  /** Draws an XObject: images are recorded (when painting is tracked), forms are run. */
  drawXObject(name: Operand | undefined, i: number): void {
    if (!isName(name)) return;
    const image = this.interpreter.trackPaints ? this.interpreter.image(name.value, this.scope.resources) : null;
    if (image) {
      this.paint({ key: this.key(i), kind: "image", points: this.unitSquare(), name: name.value, ref: image.ref });
    } else {
      this.interpreter.drawForm(name.value, this.scope, `${this.key(i)}/`, this.state);
    }
  }

  setColorSpace(name: Operand | undefined): void {
    this.state.colorSpace = isName(name) ? this.interpreter.colorSpace(name.value, this.scope.resources) : "other";
    this.state.color = initialColor(this.state.colorSpace);
  }
}

type OperatorHandler = (run: ContentRun, operands: Operand[], i: number) => void;

const coordinates = (operands: Operand[], count: number) => operands.slice(0, count).map(num);

/** A text-showing operator that first moves to the next line ("'" and '"'). */
const showOnNextLine = (run: ContentRun, item: Operand | undefined, i: number) => {
  run.nextLine(0, -run.state.text.leading);
  run.show(i, [item ?? []]);
};

const PATH_PAINTING = ["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"];

/** What each content stream operator does to the state being followed. */
const OPERATORS = new Map<string, OperatorHandler>([
  ["q", (run) => run.stack.push(cloneState(run.state))],
  [
    "Q",
    (run) => {
      const previous = run.stack.pop();
      if (previous) run.state = previous;
    },
  ],
  [
    "cm",
    (run, operands) => {
      if (operands.length >= 6)
        run.state = { ...run.state, ctm: multiply(run.state.ctm, coordinates(operands, 6) as Matrix) };
    },
  ],
  ["BT", (run) => run.beginText()],
  ["ET", (run, _operands, i) => run.endText(i)],
  ["Tf", (run, operands) => run.setFont(operands[0], operands[1])],
  [
    "Tc",
    (run, operands) => {
      run.state.text.charSpacing = num(operands[0]);
    },
  ],
  [
    "Tw",
    (run, operands) => {
      run.state.text.wordSpacing = num(operands[0]);
    },
  ],
  [
    "Tz",
    (run, operands) => {
      run.state.text.hScale = num(operands[0]) / 100;
    },
  ],
  [
    "TL",
    (run, operands) => {
      run.state.text.leading = num(operands[0]);
    },
  ],
  [
    "Ts",
    (run, operands) => {
      run.state.text.rise = num(operands[0]);
    },
  ],
  [
    "Tr",
    (run, operands) => {
      run.state.text.renderMode = num(operands[0]);
    },
  ],
  ["Td", (run, operands) => run.nextLine(num(operands[0]), num(operands[1]))],
  [
    "TD",
    (run, operands) => {
      run.state.text.leading = -num(operands[1]);
      run.nextLine(num(operands[0]), num(operands[1]));
    },
  ],
  [
    "Tm",
    (run, operands) => {
      run.tlm = coordinates(operands, 6) as Matrix;
      run.tm = [...run.tlm];
    },
  ],
  ["T*", (run) => run.nextLine(0, -run.state.text.leading)],
  ["Tj", (run, operands, i) => run.show(i, [operands[0] ?? []])],
  ["TJ", (run, operands, i) => run.show(i, Array.isArray(operands[0]) ? operands[0] : [])],
  ["'", (run, operands, i) => showOnNextLine(run, operands[0], i)],
  [
    '"',
    (run, operands, i) => {
      run.state.text.wordSpacing = num(operands[0]);
      run.state.text.charSpacing = num(operands[1]);
      showOnNextLine(run, operands[2], i);
    },
  ],
  [
    "g",
    (run, operands) => {
      run.state.colorSpace = "gray";
      run.state.color = { space: "gray", components: [num(operands[0])] };
    },
  ],
  [
    "rg",
    (run, operands) => {
      run.state.colorSpace = "rgb";
      run.state.color = { space: "rgb", components: coordinates(operands, 3) };
    },
  ],
  [
    "k",
    (run, operands) => {
      run.state.colorSpace = "cmyk";
      run.state.color = { space: "cmyk", components: coordinates(operands, 4) };
    },
  ],
  ["cs", (run, operands) => run.setColorSpace(operands[0])],
  [
    "sc",
    (run, operands) => {
      run.state.color = colorFrom(
        run.state.colorSpace,
        operands.filter((o): o is number => typeof o === "number"),
      );
    },
  ],
  [
    "scn",
    (run, operands) => {
      run.state.color = colorFrom(
        run.state.colorSpace,
        operands.filter((o): o is number => typeof o === "number"),
      );
    },
  ],
  [
    "gs",
    (run, operands) => {
      const name = operands[0];
      if (isName(name)) run.interpreter.applyExtGState(name.value, run.scope.resources, run.state);
    },
  ],
  ["Do", (run, operands, i) => run.drawXObject(operands[0], i)],
  ["BI", (run, _operands, i) => run.paint({ key: run.key(i), kind: "image", points: run.unitSquare() })],
  ["m", (run, operands) => run.addPoints(coordinates(operands, 2))],
  ["l", (run, operands) => run.addPoints(coordinates(operands, 2))],
  ["c", (run, operands) => run.addPoints(coordinates(operands, 6))],
  ["v", (run, operands) => run.addPoints(coordinates(operands, 4))],
  ["y", (run, operands) => run.addPoints(coordinates(operands, 4))],
  [
    "re",
    (run, operands) => {
      const [x, y, w, h] = coordinates(operands, 4);
      run.addPoints([x, y, x + w, y, x + w, y + h, x, y + h]);
    },
  ],
  ...PATH_PAINTING.map((op): [string, OperatorHandler] => [op, (run, _operands, i) => run.paintPath(i)]),
  [
    "n",
    (run) => {
      run.pathPoints = [];
    },
  ],
  ["sh", (run, _operands, i) => run.paint({ key: run.key(i), kind: "shading", points: [] })],
]);

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
  const w = em === 0 ? 0 : glyph.width / em;
  const { ascent, descent } = glyph.font;
  return [
    applyToPoint(m, 0, descent),
    applyToPoint(m, w, descent),
    applyToPoint(m, w, ascent),
    applyToPoint(m, 0, ascent),
  ];
}
