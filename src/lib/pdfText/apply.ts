import { PDFDict, PDFName, PDFRef, type PDFContext, type PDFFont, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";
import { IDENTITY, invert, multiply, type Matrix } from "../geometry";
import { parseEraseRanges } from "./ranges";
import type { FontCache } from "./fonts";
import type { FillColor } from "./color";
import { interpretPage, type FormInvocation, type Glyph } from "./interpreter";
import { formatNumber, formatOperand, hexString, isString, type Operand, type Operation } from "./lexer";
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
): Promise<ApplyReport> {
  const report: ApplyReport = { failed: [] };
  if (specs.length === 0) return report;
  const { context } = page.doc;
  const content = interpretPage(page, fonts, { trackCtm: true });
  if (!content.complete) {
    report.failed.push(...specs.map((spec) => spec.id));
    return report;
  }

  const erase = parseEraseRanges(specs.flatMap((spec) => spec.erase));
  const glyphsByOp = new Map<string, Glyph[]>();
  const glyphByKey = new Map<string, Glyph>();
  for (const glyph of content.glyphs) {
    const key = `${glyph.path}${glyph.op}`;
    const list = glyphsByOp.get(key) ?? [];
    list.push(glyph);
    glyphsByOp.set(key, list);
    glyphByKey.set(glyph.key, glyph);
  }

  const pageResources = localResources(context, content.resources);
  const names = new ResourceNames(pageResources);

  // Replacement drawings, grouped by the operation they follow.
  const insertions = new Map<string, string[]>();
  const lastOp = content.operations.length - 1;
  for (const spec of specs) {
    const requested = Number(spec.insertAfter);
    const atEnd = spec.insertAfter === "end" || !Number.isInteger(requested) || requested < 0 || requested > lastOp;
    const index = atEnd ? lastOp : requested;
    const ctm = index >= 0 ? (content.ctmAfter[index] ?? IDENTITY) : IDENTITY;
    try {
      const drawing = await drawSpec(spec, ctm, glyphByKey, names, resources);
      if (drawing) {
        const key = atEnd ? "end" : String(index);
        insertions.set(key, [...(insertions.get(key) ?? []), drawing]);
      }
    } catch (error) {
      console.error("No se pudo dibujar el texto editado:", error);
      report.failed.push(spec.id);
    }
  }

  const rewriter = new StreamRewriter(context, content.forms, erase, glyphsByOp);
  const parts = rewriter.rewrite(content.bytes, content.operations, "", names, insertions);
  const ends = insertions.get("end");
  if (ends) parts.push(...ends);

  const stream = context.flateStream(joinParts(parts));
  page.node.set(PDFName.of("Contents"), context.obj([context.register(stream)]));
  page.node.set(PDFName.of("Resources"), pageResources);
  return report;
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
   * with the same `identity` (or reference) share one name.
   */
  add(category: "Font" | "XObject" | "ExtGState", prefix: string, object: PDFObject, identity?: string): string {
    const id = identity ?? (object instanceof PDFRef ? object.toString() : undefined);
    const known = id !== undefined ? this.#assigned.get(`${category}:${id}`) : undefined;
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
    if (id !== undefined) this.#assigned.set(`${category}:${id}`, name);
    return name;
  }
}

// ── Erasing ────────────────────────────────────────────────────────────────

const SHOW_TEXT = new Set(["Tj", "TJ", "'", '"']);

class StreamRewriter {
  #cloneCount = 0;
  constructor(
    private readonly context: PDFContext,
    private readonly forms: Map<string, FormInvocation>,
    private readonly erase: Map<string, Set<number>>,
    private readonly glyphsByOp: Map<string, Glyph[]>,
  ) {}

  /** Whether anything inside the form drawn at `path` must be erased. */
  #touches(path: string): boolean {
    for (const key of this.erase.keys()) if (key.startsWith(path)) return true;
    return false;
  }

  rewrite(
    bytes: Uint8Array,
    operations: Operation[],
    path: string,
    names: ResourceNames,
    insertions: Map<string, string[]> | null,
  ): Part[] {
    const parts: Part[] = [];
    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      const key = `${path}${i}`;
      const erased = this.erase.get(key);
      if (erased && SHOW_TEXT.has(operation.op)) {
        parts.push(this.#rewriteShow(operation, this.glyphsByOp.get(key) ?? [], erased));
      } else if (operation.op === "Do" && this.#touches(`${key}/`)) {
        parts.push(this.#rewriteForm(`${key}/`, names) ?? bytes.subarray(operation.start, operation.end));
      } else {
        parts.push(bytes.subarray(operation.start, operation.end));
      }
      const after = insertions?.get(String(i));
      if (after) parts.push(...after);
    }
    return parts;
  }

  /** Rewrites a text-showing operation without the erased glyphs, keeping their advance. */
  #rewriteShow(operation: Operation, glyphs: Glyph[], erased: Set<number>): string {
    const { op, operands } = operation;
    const items: Operand[] = op === "TJ" ? (Array.isArray(operands[0]) ? operands[0] : []) : [operands[op === '"' ? 2 : 0] ?? []];
    const out: Operand[] = [];
    let pendingShift = 0;
    let pendingBytes: number[] = [];
    const flushBytes = () => {
      if (pendingBytes.length === 0) return;
      if (pendingShift !== 0) out.push(Number(pendingShift.toFixed(4)));
      pendingShift = 0;
      out.push({ kind: "string", bytes: Uint8Array.from(pendingBytes) });
      pendingBytes = [];
    };

    const byIndex = new Map(glyphs.map((g) => [g.index, g]));
    let index = 0;
    for (const item of items) {
      if (typeof item === "number") {
        flushBytes();
        pendingShift += item;
        continue;
      }
      if (!isString(item)) continue;
      let offset = 0;
      // Glyphs come in the same order the interpreter read them.
      while (offset < item.bytes.length) {
        const glyph = byIndex.get(index);
        const length = glyph?.length ?? 1;
        const codeBytes = Array.from(item.bytes.subarray(offset, offset + length));
        offset += length;
        if (glyph && erased.has(index)) {
          flushBytes();
          const em = glyph.size * glyph.hScale;
          if (em !== 0) pendingShift += (-glyph.advance * 1000) / em;
        } else {
          pendingBytes.push(...codeBytes);
        }
        index++;
      }
    }
    flushBytes();
    if (Math.abs(pendingShift) > 1e-6) out.push(Number(pendingShift.toFixed(4)));

    const shown = `${formatOperand(out)} TJ`;
    if (op === "'") return `T* ${shown}`;
    if (op === '"') return `${formatOperand(operands[0] ?? 0)} Tw ${formatOperand(operands[1] ?? 0)} Tc T* ${shown}`;
    return shown;
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
    fontName = names.add("Font", "YtaF", fallback.font.ref);
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
