import { glyphNameToUnicode } from "./encodings";
import { isName, isString, parseContent, type Operand } from "./lexer";

/**
 * CMaps embedded in PDF files: ToUnicode maps (code → text) and encodings of
 * composite fonts (code → CID), with the codespace ranges that say how many
 * bytes each code takes.
 */

interface CodespaceRange {
  low: Uint8Array;
  high: Uint8Array;
}

export interface CodeRead {
  code: number;
  length: number;
}

export class CMap {
  readonly codespaces: CodespaceRange[] = [];
  /** code → Unicode text (ToUnicode). */
  readonly unicode = new Map<number, string>();
  /** code → CID, as single codes and as ranges. */
  readonly cids = new Map<number, number>();
  readonly cidRanges: { low: number; high: number; cid: number }[] = [];
  /** Name of a CMap this one builds on (`usecmap`). */
  useCMap: string | undefined;

  /** Reads the next code of `bytes` from `offset` following the codespace ranges. */
  readCode(bytes: Uint8Array, offset: number): CodeRead {
    if (this.codespaces.length === 0) return { code: bytes[offset], length: 1 };
    let code = 0;
    for (let length = 1; length <= 4 && offset + length <= bytes.length; length++) {
      code = (code << 8) | bytes[offset + length - 1];
      if (this.codespaces.some((range) => inRange(range, bytes, offset, length))) return { code: code >>> 0, length };
    }
    // Not in any range: take the shortest length, as viewers do.
    const length = Math.min(this.shortestCode(), bytes.length - offset);
    let fallback = 0;
    for (let i = 0; i < length; i++) fallback = (fallback << 8) | bytes[offset + i];
    return { code: fallback >>> 0, length: Math.max(1, length) };
  }

  shortestCode(): number {
    return this.codespaces.reduce((min, range) => Math.min(min, range.low.length), 4);
  }

  /** Byte length a code is written with. */
  codeLength(code: number): number {
    for (const range of this.codespaces) {
      const low = bytesToNumber(range.low);
      const high = bytesToNumber(range.high);
      if (code >= low && code <= high) return range.low.length;
    }
    if (this.codespaces.length > 0) return this.shortestCode();
    return code > 0xff ? 2 : 1;
  }

  cid(code: number): number | undefined {
    const single = this.cids.get(code);
    if (single !== undefined) return single;
    for (const range of this.cidRanges) {
      if (code >= range.low && code <= range.high) return range.cid + (code - range.low);
    }
    return undefined;
  }
}

/** Whether the `length` bytes at `offset` fall in a codespace range of that length. */
function inRange(range: CodespaceRange, bytes: Uint8Array, offset: number, length: number): boolean {
  if (range.low.length !== length) return false;
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte < range.low[i] || byte > range.high[i]) return false;
  }
  return true;
}

function bytesToNumber(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** UTF-16BE bytes (a ToUnicode destination) as text. */
function utf16(bytes: Uint8Array): string {
  if (bytes.length === 1) return String.fromCodePoint(bytes[0]);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCodePoint((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

/** Adds `offset` to the last UTF-16 unit of `text` (bfrange destinations). */
function incrementLast(text: string, offset: number): string {
  if (offset === 0 || text.length === 0) return text;
  return text.slice(0, -1) + String.fromCodePoint((text.codePointAt(text.length - 1) ?? 0) + offset);
}

export function parseCMap(bytes: Uint8Array): CMap {
  const cmap = new CMap();
  for (const { op, operands } of parseContent(bytes)) SECTIONS.get(op)?.(cmap, operands);
  return cmap;
}

/** Operands taken `size` at a time (the entries of a CMap section). */
function* entries(operands: Operand[], size: number): Generator<Operand[]> {
  for (let i = 0; i + size - 1 < operands.length; i += size) yield operands.slice(i, i + size);
}

/** What each section of a CMap adds to it, by the operator that ends the section. */
const SECTIONS = new Map<string, (cmap: CMap, operands: Operand[]) => void>(Object.entries({
  endcodespacerange(cmap: CMap, operands: Operand[]) {
    for (const [low, high] of entries(operands, 2)) {
      if (isString(low) && isString(high) && low.bytes.length === high.bytes.length && low.bytes.length > 0) {
        cmap.codespaces.push({ low: low.bytes, high: high.bytes });
      }
    }
  },
  endbfchar(cmap: CMap, operands: Operand[]) {
    for (const [src, dst] of entries(operands, 2)) {
      if (!isString(src)) continue;
      const text = destination(dst);
      if (text !== undefined) cmap.unicode.set(bytesToNumber(src.bytes), text);
    }
  },
  endbfrange(cmap: CMap, operands: Operand[]) {
    for (const [low, high, dst] of entries(operands, 3)) {
      if (!isString(low) || !isString(high)) continue;
      const from = bytesToNumber(low.bytes);
      addRange(cmap, from, Math.min(bytesToNumber(high.bytes), from + 0xffff), dst);
    }
  },
  endcidchar(cmap: CMap, operands: Operand[]) {
    for (const [src, cid] of entries(operands, 2)) {
      if (isString(src) && typeof cid === "number") cmap.cids.set(bytesToNumber(src.bytes), cid);
    }
  },
  endcidrange(cmap: CMap, operands: Operand[]) {
    for (const [low, high, cid] of entries(operands, 3)) {
      if (isString(low) && isString(high) && typeof cid === "number") {
        cmap.cidRanges.push({ low: bytesToNumber(low.bytes), high: bytesToNumber(high.bytes), cid });
      }
    }
  },
  usecmap(cmap: CMap, operands: Operand[]) {
    const name = operands[0];
    if (isName(name)) cmap.useCMap = name.value;
  },
}));

/** A bfrange entry: an array of destinations, or one whose last unit counts up. */
function addRange(cmap: CMap, from: number, to: number, dst: Operand | undefined): void {
  if (Array.isArray(dst)) {
    dst.forEach((item, k) => {
      const text = destination(item);
      if (text !== undefined && from + k <= to) cmap.unicode.set(from + k, text);
    });
    return;
  }
  const base = destination(dst);
  if (base === undefined) return;
  for (let code = from; code <= to; code++) cmap.unicode.set(code, incrementLast(base, code - from));
}

function destination(value: Operand | undefined): string | undefined {
  if (isString(value)) return utf16(value.bytes);
  // Old ToUnicode maps may name the glyph instead.
  if (isName(value)) return glyphNameToUnicode(value.value);
  return undefined;
}

/** The predefined identity CMaps: two-byte codes that are their own CID. */
export function identityCMap(): CMap {
  const cmap = new CMap();
  cmap.codespaces.push({ low: Uint8Array.of(0, 0), high: Uint8Array.of(0xff, 0xff) });
  cmap.cidRanges.push({ low: 0, high: 0xffff, cid: 0 });
  return cmap;
}
