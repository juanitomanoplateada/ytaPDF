/**
 * Reader for PDF content streams that keeps the byte range of every
 * operation, so a stream can be rewritten by copying untouched operations
 * verbatim and replacing only the ones that change.
 */

export interface PdfName {
  kind: "name";
  value: string;
}

export interface PdfString {
  kind: "string";
  bytes: Uint8Array;
}

export interface PdfDictOperand {
  kind: "dict";
  entries: Map<string, Operand>;
}

export type Operand = number | boolean | null | PdfName | PdfString | PdfDictOperand | Operand[];

export interface Operation {
  op: string;
  operands: Operand[];
  /** Byte range of the operation (its operands and the operator) in the stream. */
  start: number;
  end: number;
}

const enum Char {
  Tab = 0x09,
  LineFeed = 0x0a,
  FormFeed = 0x0c,
  Return = 0x0d,
  Space = 0x20,
  Percent = 0x25,
  ParenOpen = 0x28,
  ParenClose = 0x29,
  Plus = 0x2b,
  Minus = 0x2d,
  Period = 0x2e,
  Slash = 0x2f,
  Less = 0x3c,
  Greater = 0x3e,
  BracketOpen = 0x5b,
  Backslash = 0x5c,
  BracketClose = 0x5d,
  BraceOpen = 0x7b,
  BraceClose = 0x7d,
}

const WHITESPACE = new Uint8Array(256);
for (const c of [0x00, Char.Tab, Char.LineFeed, Char.FormFeed, Char.Return, Char.Space]) WHITESPACE[c] = 1;

const DELIMITER = new Uint8Array(256);
for (const c of [
  Char.ParenOpen,
  Char.ParenClose,
  Char.Less,
  Char.Greater,
  Char.BracketOpen,
  Char.BracketClose,
  Char.BraceOpen,
  Char.BraceClose,
  Char.Slash,
  Char.Percent,
]) {
  DELIMITER[c] = 1;
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isRegular = (c: number) => !WHITESPACE[c] && !DELIMITER[c];

/** Marks the end of an array or dictionary while reading nested operands. */
const CLOSE_ARRAY = Symbol("]");
const CLOSE_DICT = Symbol(">>");
type Token = Operand | { keyword: string } | typeof CLOSE_ARRAY | typeof CLOSE_DICT;

const isKeyword = (token: Token): token is { keyword: string } =>
  typeof token === "object" && token !== null && "keyword" in token;

class Lexer {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  skipSpace(): void {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const c = bytes[this.pos];
      if (WHITESPACE[c]) {
        this.pos++;
      } else if (c === Char.Percent) {
        while (this.pos < bytes.length && bytes[this.pos] !== Char.LineFeed && bytes[this.pos] !== Char.Return) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  /** Reads the next token, or `undefined` at the end of the stream. */
  next(): Token | undefined {
    this.skipSpace();
    const { bytes } = this;
    if (this.pos >= bytes.length) return undefined;
    const c = bytes[this.pos];

    switch (c) {
      case Char.Slash:
        return this.readName();
      case Char.ParenOpen:
        return this.readLiteralString();
      case Char.Less:
        if (bytes[this.pos + 1] === Char.Less) {
          this.pos += 2;
          return this.readDict();
        }
        return this.readHexString();
      case Char.BracketOpen:
        this.pos++;
        return this.readArray();
      case Char.BracketClose:
        this.pos++;
        return CLOSE_ARRAY;
      case Char.Greater:
        this.pos += bytes[this.pos + 1] === Char.Greater ? 2 : 1;
        return CLOSE_DICT;
      case Char.ParenClose:
      case Char.BraceOpen:
      case Char.BraceClose:
        // Not valid in content streams; skipped like PDF viewers do.
        this.pos++;
        return this.next();
    }

    if (isDigit(c) || c === Char.Plus || c === Char.Minus || c === Char.Period) return this.readNumber();

    const start = this.pos;
    while (this.pos < bytes.length && isRegular(bytes[this.pos])) this.pos++;
    const word = latin1(bytes.subarray(start, this.pos));
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { keyword: word };
  }

  readNumber(): number {
    const { bytes } = this;
    const start = this.pos;
    while (this.pos < bytes.length && isRegular(bytes[this.pos])) this.pos++;
    let text = latin1(bytes.subarray(start, this.pos));
    // Some writers emit "--5" or "-.5-": keep the sign and the first number.
    text = text.replace(/^([+-])[+-]+/, "$1");
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : 0;
  }

  readName(): PdfName {
    const { bytes } = this;
    this.pos++;
    const start = this.pos;
    while (this.pos < bytes.length && isRegular(bytes[this.pos])) this.pos++;
    const raw = latin1(bytes.subarray(start, this.pos));
    const value = raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    return { kind: "name", value };
  }

  readLiteralString(): PdfString {
    const { bytes } = this;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < bytes.length) {
      const c = bytes[this.pos++];
      if (c === Char.Backslash) {
        if (this.pos >= bytes.length) break;
        const e = bytes[this.pos++];
        switch (e) {
          case 0x6e: // n
            out.push(Char.LineFeed);
            break;
          case 0x72: // r
            out.push(Char.Return);
            break;
          case 0x74: // t
            out.push(Char.Tab);
            break;
          case 0x62: // b
            out.push(0x08);
            break;
          case 0x66: // f
            out.push(Char.FormFeed);
            break;
          case Char.Return:
            // Line continuation: the backslash and the end of line are dropped.
            if (bytes[this.pos] === Char.LineFeed) this.pos++;
            break;
          case Char.LineFeed:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let value = e - 0x30;
              for (let i = 0; i < 2 && bytes[this.pos] >= 0x30 && bytes[this.pos] <= 0x37; i++) {
                value = value * 8 + (bytes[this.pos++] - 0x30);
              }
              out.push(value & 0xff);
            } else {
              out.push(e);
            }
        }
      } else if (c === Char.ParenOpen) {
        depth++;
        out.push(c);
      } else if (c === Char.ParenClose) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === Char.Return) {
        // An unescaped end of line is read as a single line feed.
        if (bytes[this.pos] === Char.LineFeed) this.pos++;
        out.push(Char.LineFeed);
      } else {
        out.push(c);
      }
    }
    return { kind: "string", bytes: Uint8Array.from(out) };
  }

  readHexString(): PdfString {
    const { bytes } = this;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < bytes.length) {
      const c = bytes[this.pos++];
      if (c === Char.Greater) break;
      const value = hexValue(c);
      if (value >= 0) digits.push(value);
    }
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[i * 2] << 4) | digits[i * 2 + 1];
    return { kind: "string", bytes: out };
  }

  readArray(): Operand[] {
    const items: Operand[] = [];
    for (;;) {
      const token = this.next();
      if (token === undefined || token === CLOSE_ARRAY) return items;
      if (token === CLOSE_DICT || isKeyword(token)) continue;
      items.push(token);
    }
  }

  readDict(): PdfDictOperand {
    const entries = new Map<string, Operand>();
    let key: string | null = null;
    for (;;) {
      const token = this.next();
      if (token === undefined || token === CLOSE_DICT) break;
      if (token === CLOSE_ARRAY || isKeyword(token)) continue;
      if (key === null) {
        if (typeof token === "object" && token !== null && !Array.isArray(token) && token.kind === "name") key = token.value;
      } else {
        entries.set(key, token);
        key = null;
      }
    }
    return { kind: "dict", entries };
  }

  /**
   * Skips the binary data of an inline image. `pos` is right after the `ID`
   * keyword; on return it is right after the closing `EI`.
   */
  skipInlineImageData(): void {
    const { bytes } = this;
    // A single whitespace byte separates ID from the data.
    if (WHITESPACE[bytes[this.pos]]) this.pos++;
    for (let i = this.pos; i + 1 < bytes.length; i++) {
      if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue; // "EI"
      // Writers usually put whitespace before EI, but not all do: what
      // follows is what tells the end of the data apart from image bytes.
      const after = i + 2 >= bytes.length || WHITESPACE[bytes[i + 2]] || DELIMITER[bytes[i + 2]];
      if (after && looksLikeOperators(bytes, i + 2)) {
        this.pos = i + 2;
        return;
      }
    }
    this.pos = bytes.length;
  }
}

/** Whether the bytes after a candidate `EI` read as text rather than image data. */
function looksLikeOperators(bytes: Uint8Array, from: number): boolean {
  const end = Math.min(bytes.length, from + 32);
  for (let i = from; i < end; i++) {
    const c = bytes[i];
    if (c > 0x7e || (c < 0x20 && !WHITESPACE[c])) return false;
  }
  return true;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/** Splits a decoded content stream into operations. */
export function parseContent(bytes: Uint8Array): Operation[] {
  const lexer = new Lexer(bytes);
  const operations: Operation[] = [];
  let operands: Operand[] = [];
  let start = -1;

  for (;;) {
    lexer.skipSpace();
    const tokenStart = lexer.pos;
    const token = lexer.next();
    if (token === undefined) break;
    if (start < 0) start = tokenStart;

    if (token === CLOSE_ARRAY || token === CLOSE_DICT) continue;
    if (!isKeyword(token)) {
      operands.push(token);
      continue;
    }

    if (token.keyword === "BI") {
      // Inline image: its dictionary is read up to ID, then the data is skipped.
      const dict: PdfDictOperand = { kind: "dict", entries: new Map() };
      let key: string | null = null;
      for (;;) {
        const part = lexer.next();
        if (part === undefined) break;
        if (isKeyword(part)) {
          if (part.keyword === "ID") break;
          continue;
        }
        if (part === CLOSE_ARRAY || part === CLOSE_DICT) continue;
        if (key === null) {
          if (typeof part === "object" && part !== null && !Array.isArray(part) && part.kind === "name") key = part.value;
        } else {
          dict.entries.set(key, part);
          key = null;
        }
      }
      lexer.skipInlineImageData();
      operations.push({ op: "BI", operands: [dict], start, end: lexer.pos });
    } else {
      operations.push({ op: token.keyword, operands, start, end: lexer.pos });
    }
    operands = [];
    start = -1;
  }
  return operations;
}

// ── Writing ──────────────────────────────────────────────────────────────

/** Formats a number without exponents, with up to 6 decimals. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function formatName(value: string): string {
  let out = "/";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const plain = c > 0x20 && c < 0x7f && c !== 0x23 && isRegular(c);
    out += plain ? value[i] : `#${c.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export function hexString(bytes: ArrayLike<number>): string {
  let out = "<";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return `${out}>`;
}

export function formatOperand(operand: Operand): string {
  if (operand === null) return "null";
  if (typeof operand === "number") return formatNumber(operand);
  if (typeof operand === "boolean") return operand ? "true" : "false";
  if (Array.isArray(operand)) return `[${operand.map(formatOperand).join(" ")}]`;
  switch (operand.kind) {
    case "name":
      return formatName(operand.value);
    case "string":
      return hexString(operand.bytes);
    case "dict":
      return `<<${[...operand.entries].map(([key, value]) => `${formatName(key)} ${formatOperand(value)}`).join(" ")}>>`;
  }
}

export function formatOperation(op: string, operands: Operand[] = []): string {
  return operands.length > 0 ? `${operands.map(formatOperand).join(" ")} ${op}` : op;
}

export function isName(value: Operand | undefined): value is PdfName {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "name";
}

export function isString(value: Operand | undefined): value is PdfString {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "string";
}
