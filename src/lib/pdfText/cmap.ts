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
      for (const range of this.codespaces) {
        if (range.low.length !== length) continue;
        let inside = true;
        for (let i = 0; i < length && inside; i++) {
          const byte = bytes[offset + i];
          inside = byte >= range.low[i] && byte <= range.high[i];
        }
        if (inside) return { code: code >>> 0, length };
      }
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
    return this.codespaces.length > 0 ? this.shortestCode() : code > 0xff ? 2 : 1;
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

function bytesToNumber(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** UTF-16BE bytes (a ToUnicode destination) as text. */
function utf16(bytes: Uint8Array): string {
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

/** Adds `offset` to the last UTF-16 unit of `text` (bfrange destinations). */
function incrementLast(text: string, offset: number): string {
  if (offset === 0 || text.length === 0) return text;
  return text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) + offset);
}

export function parseCMap(bytes: Uint8Array): CMap {
  const cmap = new CMap();
  for (const { op, operands } of parseContent(bytes)) {
    switch (op) {
      case "endcodespacerange":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const low = operands[i];
          const high = operands[i + 1];
          if (isString(low) && isString(high) && low.bytes.length === high.bytes.length && low.bytes.length > 0) {
            cmap.codespaces.push({ low: low.bytes, high: high.bytes });
          }
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const src = operands[i];
          const dst = operands[i + 1];
          if (!isString(src)) continue;
          const text = destination(dst);
          if (text !== undefined) cmap.unicode.set(bytesToNumber(src.bytes), text);
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < operands.length; i += 3) {
          const low = operands[i];
          const high = operands[i + 1];
          const dst = operands[i + 2];
          if (!isString(low) || !isString(high)) continue;
          const from = bytesToNumber(low.bytes);
          const to = Math.min(bytesToNumber(high.bytes), from + 0xffff);
          if (Array.isArray(dst)) {
            dst.forEach((item, k) => {
              const text = destination(item);
              if (text !== undefined && from + k <= to) cmap.unicode.set(from + k, text);
            });
          } else {
            const base = destination(dst);
            if (base === undefined) continue;
            for (let code = from; code <= to; code++) cmap.unicode.set(code, incrementLast(base, code - from));
          }
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < operands.length; i += 2) {
          const src = operands[i];
          const cid = operands[i + 1];
          if (isString(src) && typeof cid === "number") cmap.cids.set(bytesToNumber(src.bytes), cid);
        }
        break;
      case "endcidrange":
        for (let i = 0; i + 2 < operands.length; i += 3) {
          const low = operands[i];
          const high = operands[i + 1];
          const cid = operands[i + 2];
          if (isString(low) && isString(high) && typeof cid === "number") {
            cmap.cidRanges.push({ low: bytesToNumber(low.bytes), high: bytesToNumber(high.bytes), cid });
          }
        }
        break;
      case "usecmap": {
        const name = operands[0];
        if (isName(name)) cmap.useCMap = name.value;
        break;
      }
    }
  }
  return cmap;
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
