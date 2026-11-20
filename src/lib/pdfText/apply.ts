import { PDFDict, PDFName, type PDFContext, type PDFFont, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";
import { IDENTITY, invert, multiply, type Matrix } from "../geometry";
import { parseEraseRanges } from "./ranges";
import type { FontCache } from "./fonts";
import type { FillColor } from "./color";
import { interpretPage, type FormInvocation, type Glyph, type PageContent } from "./interpreter";
import { formatNumber, formatOperand, hexString, isName, isString, type Operand, type Operation } from "./lexer";
import { dictOf } from "./pdfObjects";
import type { NativeRun, NativeSpec, RunFont } from "./types";

/** A font to draw replacement text with when the original cannot. */
export interface FallbackFont {
  font: PDFFont;
  /** Text the font can actually encode; other characters are replaced. */
  prepare(text: string): string;
}

export interface ApplyResources {
  fallbackFont(font: Extract<RunFont, { kind: "fallback" }>): Promise<FallbackFont>;
}

export interface ApplyOptions {
  /**
   * Painting operations to remove (`<form path><operation>` keys of
   * `PaintedArea`): paths are ended without painting, images are not drawn.
   */
  drop?: Set<string>;
  /** The page as already read (with `trackCtm`), to avoid reading it twice. */
  content?: PageContent;
}

export interface ApplyReport {
  /** Specs whose erasures or drawing could not be done completely. */
  failed: string[];
}

const encoder = new TextEncoder();

/** Pieces of a rewritten stream: original bytes copied as they were, or new operators (ASCII). */
type Part = string | Uint8Array;

function joinParts(parts: Part[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    out[offset + chunk.length] = 0x0a;
    offset += chunk.length + 1;
  }
  return out;
}

/**
 * Replaces original text on a page: the glyphs listed by each spec are
 * removed from the content (their space is kept, so nothing else moves) and
 * the new text is drawn where the old one was in the drawing order.
 *
 * The page's content streams are replaced by a single new stream and its
 * resources by a page-local copy, so objects shared with other pages are
 * never modified.
 */
export async function applyNativeSpecs(
  page: PDFPage,
  specs: NativeSpec[],
  fonts: FontCache,
  resources: ApplyResources,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  const report: ApplyReport = { failed: [] };
  const drop = options.drop ?? new Set<string>();
  if (specs.length === 0 && drop.size === 0) return report;
  const { context } = page.doc;
  const content = options.content ?? interpretPage(page, fonts, { trackCtm: true });
  if (!content.complete) {
    report.failed.push(...specs.map((spec) => spec.id));
    return report;
  }

  const erase = parseEraseRanges(specs.flatMap((spec) => spec.erase));
  const { glyphsByOp, glyphByKey } = indexGlyphs(content.glyphs);
  const pageResources = localResources(context, content.resources);
  const names = new ResourceNames(pageResources);

  // Replacement drawings, grouped by the operation they follow.
  const insertions = new Map<string, string[]>();
  for (const spec of specs) {
    const { key, ctm } = insertionPoint(spec, content);
    try {
      const drawing = await drawSpec(spec, ctm, glyphByKey, names, resources);
      if (drawing) insertions.set(key, [...(insertions.get(key) ?? []), drawing]);
    } catch (error) {
      console.error("No se pudo dibujar el texto editado:", error);
      report.failed.push(spec.id);
    }
  }

  const rewriter = new StreamRewriter(context, content.forms, erase, glyphsByOp, drop);
  const parts = rewriter.rewrite(content.bytes, content.operations, "", names, insertions);
  const ends = insertions.get("end");
  if (ends) parts.push(...ends);

  const stream = context.flateStream(joinParts(parts));
  page.node.set(PDFName.of("Contents"), context.obj([context.register(stream)]));
  page.node.set(PDFName.of("Resources"), pageResources);
  // pdf-lib keeps the stream it last drew into (form flattening, for one);
  // its operators are now part of the new stream, so drawing starts afresh.
  const drawing = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  drawing.contentStream = undefined;
  drawing.contentStreamRef = undefined;
  return report;
}

/** The glyphs of a page by operation (`<path><op>`) and by key. */
function indexGlyphs(glyphs: Glyph[]): { glyphsByOp: Map<string, Glyph[]>; glyphByKey: Map<string, Glyph> } {
  const glyphsByOp = new Map<string, Glyph[]>();
  const glyphByKey = new Map<string, Glyph>();
  for (const glyph of glyphs) {
    const key = `${glyph.path}${glyph.op}`;
    const list = glyphsByOp.get(key) ?? [];
    list.push(glyph);
    glyphsByOp.set(key, list);
    glyphByKey.set(glyph.key, glyph);
  }
  return { glyphsByOp, glyphByKey };
}

/** Where a spec's drawing goes (after which top-level operation, or "end") and the CTM there. */
function insertionPoint(spec: NativeSpec, content: PageContent): { key: string; ctm: Matrix } {
  const lastOp = content.operations.length - 1;
  const requested = Number(spec.insertAfter);
  const atEnd = spec.insertAfter === "end" || !Number.isInteger(requested) || requested < 0 || requested > lastOp;
  const index = atEnd ? lastOp : requested;
  const ctm = index >= 0 ? (content.ctmAfter[index] ?? IDENTITY) : IDENTITY;
  return { key: atEnd ? "end" : String(index), ctm };
}

// ── Resources ──────────────────────────────────────────────────────────────

const RESOURCE_CATEGORIES = ["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"];

/** A direct copy of a resource dictionary whose categories can take new names safely. */
function localResources(context: PDFContext, source: PDFDict | undefined): PDFDict {
  const copy = context.obj({});
  if (source) for (const [key, value] of source.entries()) copy.set(key, value);
  for (const category of RESOURCE_CATEGORIES) {
    const name = PDFName.of(category);
    const dict = dictOf(context, copy.get(name));
    if (!dict) continue;
    const entries = context.obj({});
    for (const [key, value] of dict.entries()) entries.set(key, value);
    copy.set(name, entries);
  }
  return copy;
}

class ResourceNames {
  readonly #assigned = new Map<string, string>();
  constructor(readonly resources: PDFDict) {}

  /**
   * Adds `object` under a new name in `category` and returns the name. Objects
   * with the same `identity` share one name.
   */
  add(category: "Font" | "XObject" | "ExtGState", prefix: string, object: PDFObject, identity: string): string {
    const known = this.#assigned.get(`${category}:${identity}`);
    if (known) return known;
    const key = PDFName.of(category);
    let dict = this.resources.get(key);
    if (!(dict instanceof PDFDict)) {
      dict = this.resources.context.obj({});
      this.resources.set(key, dict);
    }
    const target = dict as PDFDict;
    let n = 0;
    while (target.has(PDFName.of(`${prefix}${n}`))) n++;
    const name = `${prefix}${n}`;
    target.set(PDFName.of(name), object);
    this.#assigned.set(`${category}:${identity}`, name);
    return name;
  }

  /** Removes a name from the (local) resources: what it pointed to is no longer drawn here. */
  remove(category: "XObject", name: string): void {
    const dict = this.resources.get(PDFName.of(category));
    if (dict instanceof PDFDict) dict.delete(PDFName.of(name));
  }
}

// ── Erasing ────────────────────────────────────────────────────────────────

const SHOW_TEXT = new Set(["Tj", "TJ", "'", '"']);
/** Operations that paint something by themselves and are simply left out when dropped. */
const DROPPABLE = new Set(["Do", "BI", "sh"]);

interface RewriteContext {
  bytes: Uint8Array;
  path: string;
  names: ResourceNames;
  /** Marked-content sequences that contain something erased. */
  touched: Set<number>;
  /** XObjects some operation stopped drawing, and those still drawn. */
  replaced: Set<string>;
  drawn: Set<string>;
}

/**
 * A dropped painting operation: paths end without painting ("n"), images and
 * shadings are left out (null). Undefined for operations that paint nothing.
 */
function dropOperation(operation: Operation, context: RewriteContext): Part | null | undefined {
  if (PAINT_PATH.has(operation.op)) return "n";
  if (!DROPPABLE.has(operation.op)) return undefined;
  const name = operation.operands[0];
  if (operation.op === "Do" && isName(name)) context.replaced.add(name.value);
  return null;
}

/** The strings and numbers a text-showing operation shows. */
function showItems({ op, operands }: Operation): Operand[] {
  if (op === "TJ") return Array.isArray(operands[0]) ? operands[0] : [];
  return [operands[op === '"' ? 2 : 0] ?? []];
}

/** The operands of a rewritten TJ: kept codes, and shifts where erased glyphs were. */
class ShownText {
  readonly #out: Operand[] = [];
  #shift = 0;
  #bytes: number[] = [];

  shift(amount: number): void {
    this.#flush();
    this.#shift += amount;
  }

  keep(bytes: number[]): void {
    this.#bytes.push(...bytes);
  }

  #flush(): void {
    if (this.#bytes.length === 0) return;
    if (this.#shift !== 0) this.#out.push(Number(this.#shift.toFixed(4)));
    this.#shift = 0;
    this.#out.push({ kind: "string", bytes: Uint8Array.from(this.#bytes) });
    this.#bytes = [];
  }

  finish(): Operand[] {
    this.#flush();
    if (Math.abs(this.#shift) > 1e-6) this.#out.push(Number(this.#shift.toFixed(4)));
    return this.#out;
  }
}

/**
 * Goes through the codes of a shown string (glyphs come in the order the
 * interpreter read them, numbered from `index`), keeping the others and
 * turning erased ones into a shift of their advance. Returns the next index.
 */
function eraseFrom(
  bytes: Uint8Array,
  index: number,
  byIndex: Map<number, Glyph>,
  erased: Set<number>,
  shown: ShownText,
): number {
  let offset = 0;
  let next = index;
  while (offset < bytes.length) {
    const glyph = byIndex.get(next);
    const length = glyph?.length ?? 1;
    const code = Array.from(bytes.subarray(offset, offset + length));
    offset += length;
    if (glyph && erased.has(next)) {
      const em = glyph.size * glyph.hScale;
      shown.shift(em === 0 ? 0 : (-glyph.advance * 1000) / em);
    } else {
      shown.keep(code);
    }
    next++;
  }
  return next;
}
const PAINT_PATH = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
/** Marked-content properties that repeat the text or describe what is drawn. */
const DESCRIPTIVE_PROPERTIES = ["ActualText", "Alt", "E"];

class StreamRewriter {
  #cloneCount = 0;
  constructor(
    private readonly context: PDFContext,
    private readonly forms: Map<string, FormInvocation>,
    private readonly erase: Map<string, Set<number>>,
    private readonly glyphsByOp: Map<string, Glyph[]>,
    private readonly drop: Set<string>,
  ) {}

  /** Whether anything inside the form drawn at `path` must be erased. */
  #touches(path: string): boolean {
    for (const key of this.erase.keys()) if (key.startsWith(path)) return true;
    for (const key of this.drop) if (key.startsWith(path)) return true;
    return false;
  }

  /**
   * Marked-content sequences (BDC … EMC) that contain something erased: their
   * replacement text and descriptions would otherwise keep what was removed.
   */
  #touchedSequences(operations: Operation[], path: string): Set<number> {
    const touched = new Set<number>();
    const open: number[] = [];
    for (let i = 0; i < operations.length; i++) {
      const { op } = operations[i];
      if (op === "BDC" || op === "BMC") open.push(i);
      else if (op === "EMC") open.pop();
      else {
        const key = `${path}${i}`;
        if (this.erase.has(key) || this.drop.has(key) || (op === "Do" && this.#touches(`${key}/`))) {
          for (const index of open) touched.add(index);
        }
      }
    }
    return touched;
  }

  rewrite(
    bytes: Uint8Array,
    operations: Operation[],
    path: string,
    names: ResourceNames,
    insertions: Map<string, string[]> | null,
  ): Part[] {
    const parts: Part[] = [];
    const context: RewriteContext = {
      bytes,
      path,
      names,
      touched: this.#touchedSequences(operations, path),
      replaced: new Set(),
      drawn: new Set(),
    };
    for (let i = 0; i < operations.length; i++) {
      const part = this.#rewriteOperation(operations[i], i, context);
      if (part !== null) parts.push(part);
      const after = insertions?.get(String(i));
      if (after) parts.push(...after);
    }
    for (const name of context.replaced) if (!context.drawn.has(name)) names.remove("XObject", name);
    return parts;
  }

  /** What replaces one operation (null: nothing), noting the XObjects it stops or keeps drawing. */
  #rewriteOperation(operation: Operation, i: number, context: RewriteContext): Part | null {
    const { op } = operation;
    const key = `${context.path}${i}`;
    const original = context.bytes.subarray(operation.start, operation.end);
    const dropped = this.drop.has(key) ? dropOperation(operation, context) : undefined;
    if (dropped !== undefined) return dropped;
    const erased = this.erase.get(key);
    if (erased && SHOW_TEXT.has(op)) return this.#rewriteShow(operation, this.glyphsByOp.get(key) ?? [], erased);
    if (op === "Do") return this.#rewriteDo(operation, key, original, context);
    if (op === "BDC" && context.touched.has(i)) return withoutDescriptions(operation) ?? original;
    return original;
  }

  /** A form with something erased inside is drawn as a copy; anything else stays as it is. */
  #rewriteDo(operation: Operation, key: string, original: Uint8Array, context: RewriteContext): Part {
    const name = operation.operands[0];
    const xobject = isName(name) ? name.value : undefined;
    const clone = this.#touches(`${key}/`) ? this.#rewriteForm(`${key}/`, context.names) : null;
    if (xobject) (clone ? context.replaced : context.drawn).add(xobject);
    return clone ?? original;
  }

  /** Rewrites a text-showing operation without the erased glyphs, keeping their advance. */
  #rewriteShow(operation: Operation, glyphs: Glyph[], erased: Set<number>): string {
    const { op, operands } = operation;
    const shown = new ShownText();
    const byIndex = new Map(glyphs.map((g) => [g.index, g]));
    let index = 0;
    for (const item of showItems(operation)) {
      if (typeof item === "number") shown.shift(item);
      else if (isString(item)) index = eraseFrom(item.bytes, index, byIndex, erased, shown);
    }
    const text = `${formatOperand(shown.finish())} TJ`;
    if (op === "'") return `T* ${text}`;
    if (op === '"') return `${formatOperand(operands[0] ?? 0)} Tw ${formatOperand(operands[1] ?? 0)} Tc T* ${text}`;
    return text;
  }

  /** Draws a modified copy of a form instead of the shared original. */
  #rewriteForm(path: string, names: ResourceNames): string | null {
    const form = this.forms.get(path);
    if (!form) return null;
    const formResources = localResources(this.context, form.resources);
    const inner = new ResourceNames(formResources);
    const body = joinParts(this.rewrite(form.bytes, form.operations, path, inner, null));

    const clone = this.context.flateStream(body);
    for (const [key, value] of form.stream.dict.entries()) {
      const name = key.asString();
      if (name === "/Length" || name === "/Filter" || name === "/DecodeParms" || name === "/DL") continue;
      clone.dict.set(key, value);
    }
    clone.dict.set(PDFName.of("Resources"), formResources);
    const ref = this.context.register(clone);
    const name = names.add("XObject", "YtaX", ref, `clone-${path}-${this.#cloneCount++}`);
    return `/${name} Do`;
  }
}

/** A BDC operation without the properties that describe its content, or null if it has none. */
function withoutDescriptions(operation: Operation): string | null {
  const [tag, properties] = operation.operands;
  if (!isName(tag) || typeof properties !== "object" || properties === null || Array.isArray(properties)) return null;
  if (properties.kind !== "dict") return null;
  if (!DESCRIPTIVE_PROPERTIES.some((key) => properties.entries.has(key))) return null;
  const entries = new Map(properties.entries);
  for (const key of DESCRIPTIVE_PROPERTIES) entries.delete(key);
  return `${formatOperand(tag)} ${formatOperand({ kind: "dict", entries })} BDC`;
}

// ── Drawing ────────────────────────────────────────────────────────────────

function colorOperator(color: FillColor): string {
  const values = color.components.map((v) => formatNumber(Math.min(1, Math.max(0, v)))).join(" ");
  if (color.space === "gray") return `${values} g`;
  if (color.space === "cmyk") return `${values} k`;
  return `${values} rg`;
}

const colorKey = (color: FillColor) => `${color.space}:${color.components.join(",")}`;

async function drawSpec(
  spec: NativeSpec,
  ctmAtInsertion: Matrix,
  glyphByKey: Map<string, Glyph>,
  names: ResourceNames,
  resources: ApplyResources,
): Promise<string | null> {
  if (spec.runs.length === 0 && spec.underlines.length === 0) return null;
  let toLocal: Matrix;
  try {
    // The drawing happens where the CTM is `ctmAtInsertion`; `cm` brings it to the spec's space.
    toLocal = multiply(invert(ctmAtInsertion), spec.matrix);
  } catch {
    toLocal = spec.matrix;
  }

  const out: string[] = ["q", `${toLocal.map(formatNumber).join(" ")} cm`];
  if (spec.opacity !== undefined) {
    const context = names.resources.context;
    const alpha = Math.min(1, Math.max(0, spec.opacity));
    const gs = context.obj({ Type: "ExtGState", ca: alpha, CA: alpha });
    const name = names.add("ExtGState", "YtaGS", gs, `alpha-${alpha}`);
    out.push(`/${name} gs`);
  }

  if (spec.runs.length > 0) {
    out.push("BT", `0 Tc 0 Tw 100 Tz 0 Ts ${Math.max(0, Math.min(2, spec.renderMode))} Tr`);
    for (const run of spec.runs) out.push(...(await drawRun(run, glyphByKey, names, resources)));
    out.push("ET");
  }

  let lastColor = "";
  for (const line of spec.underlines) {
    const key = colorKey(line.color);
    if (key !== lastColor) out.push(colorOperator(line.color));
    lastColor = key;
    out.push(`${[line.x, line.y, line.width, line.thickness].map(formatNumber).join(" ")} re f`);
  }
  out.push("Q");
  return out.join("\n");
}

async function drawRun(
  run: NativeRun,
  glyphByKey: Map<string, Glyph>,
  names: ResourceNames,
  resources: ApplyResources,
): Promise<string[]> {
  const out: string[] = [];
  let fontName: string;
  let encode: (glyph: NativeRun["glyphs"][number]) => { bytes: string; width: number } | null;

  const original = run.font.kind === "original" ? glyphByKey.get(run.font.sample) : undefined;
  if (original) {
    fontName = names.add("Font", "YtaF", original.fontObject, `font-${original.font.id}`);
    encode = (glyph) => {
      if (glyph.code === undefined || glyph.code < 0) return null;
      const length = glyph.length ?? 1;
      const bytes: number[] = [];
      for (let i = length - 1; i >= 0; i--) bytes.push((glyph.code >>> (8 * i)) & 0xff);
      return { bytes: hexString(bytes), width: glyph.width ?? 0 };
    };
  } else {
    const fallback = await resources.fallbackFont(
      run.font.kind === "fallback" ? run.font : { kind: "fallback", family: "", weight: "normal", style: "normal" },
    );
    fontName = names.add("Font", "YtaF", fallback.font.ref, `fallback-${fallback.font.ref.toString()}`);
    encode = (glyph) => {
      const text = fallback.prepare(glyph.text);
      if (!text || /^\s+$/.test(text)) return null;
      return {
        bytes: fallback.font.encodeText(text).toString(),
        width: fallback.font.widthOfTextAtSize(text, 1000),
      };
    };
  }

  out.push(`/${fontName} ${formatNumber(run.size)} Tf`, colorOperator(run.color));

  // Consecutive glyphs on one baseline share a TJ; shifts place each exactly.
  let line: string[] = [];
  let cursor: { x: number; y: number } | null = null;
  const flush = () => {
    if (line.length > 0) out.push(`[${line.join(" ")}] TJ`);
    line = [];
  };
  for (const glyph of run.glyphs) {
    const encoded = encode(glyph);
    if (!encoded) continue;
    if (!cursor || Math.abs(cursor.y - glyph.y) > 1e-6) {
      flush();
      out.push(`1 0 0 1 ${formatNumber(glyph.x)} ${formatNumber(glyph.y)} Tm`);
    } else {
      const shift = (-(glyph.x - cursor.x) * 1000) / run.size;
      if (Math.abs(shift) > 0.01) line.push(formatNumber(Number(shift.toFixed(3))));
    }
    line.push(encoded.bytes);
    cursor = { x: glyph.x + (encoded.width / 1000) * run.size, y: glyph.y };
  }
  flush();
  return out;
}
