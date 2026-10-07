import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  StandardFontEmbedder,
  type PDFContext,
  type PDFObject,
  type PDFStream,
} from "@cantoo/pdf-lib";
import { CMap, identityCMap, parseCMap, type CodeRead } from "./cmap";
import { ENCODINGS, glyphNameToUnicode, type EncodingName } from "./encodings";
import { arrayOf, dictOf, nameOf, numberOf, numbersOf, resolve, streamBytes, streamOf } from "./pdfObjects";

export type ProgramKind = "TrueType" | "CFF" | "Type1" | "OpenType";

/** AFM metrics of a standard 14 font, as bundled with pdf-lib. */
type StandardFontMetrics = StandardFontEmbedder["font"];

type StandardName =
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique"
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Symbol"
  | "ZapfDingbats";

const standardFonts = new Map<StandardName, StandardFontEmbedder>();

function standardFont(name: StandardName): StandardFontEmbedder {
  let font = standardFonts.get(name);
  if (!font) {
    font = StandardFontEmbedder.for(name as never);
    standardFonts.set(name, font);
  }
  return font;
}

/**
 * A font as used by a page's content: how its strings split into codes, how
 * far each code advances, and what text it represents.
 */
export class PdfFont {
  /** Identifies the font object within its document. */
  readonly id: string;
  readonly dict: PDFDict;
  /** The value found in the resources: a reference, or the dictionary itself. */
  readonly object: PDFObject;
  readonly subtype: string;
  readonly baseName: string;
  /** Font name without the subset tag ("ABCDEF+"). */
  readonly name: string;
  readonly subset: boolean;
  readonly composite: boolean;
  /** Glyph space → text space (0.001 for everything but Type 3). */
  readonly scale: number;
  readonly vertical: boolean;
  /** Whether strings can be split into codes (unknown predefined CMaps cannot). */
  readonly decodable: boolean;
  ascent = 0.8;
  descent = -0.2;
  bold = false;
  italic = false;
  serif = false;
  monospace = false;
  symbolic = false;
  program: { kind: ProgramKind; stream: PDFStream } | undefined;
  /** CIDFontType2: CID → glyph index ("identity" or a table). */
  cidToGid: "identity" | Uint16Array | undefined;

  #encoding: CMap | undefined;
  #toUnicode: CMap | undefined;
  /** Simple fonts: glyph name per code. */
  #glyphNames: string[] | undefined;
  #widths = new Map<number, number>();
  #defaultWidth = 0;
  #cidWidths: { from: number; to: number; width: number }[] = [];
  #standardMetrics: StandardFontMetrics | undefined;
  #symbolUnicode: Map<number, string> | undefined;

  constructor(context: PDFContext, object: PDFObject, id: string) {
    const dict = dictOf(context, object) ?? context.obj({});
    this.id = id;
    this.object = object;
    this.dict = dict;
    this.subtype = nameOf(context, dict.get(PDFName.of("Subtype"))) ?? "Type1";
    this.baseName = nameOf(context, dict.get(PDFName.of("BaseFont"))) ?? "";
    const tagged = /^[A-Z]{6}\+/.test(this.baseName);
    this.subset = tagged;
    this.name = tagged ? this.baseName.slice(7) : this.baseName;
    this.composite = this.subtype === "Type0";

    const descendant = this.composite
      ? dictOf(context, arrayOf(context, dict.get(PDFName.of("DescendantFonts")))?.get(0))
      : undefined;
    const descriptorOwner = descendant ?? dict;
    this.#readDescriptor(context, dictOf(context, descriptorOwner.get(PDFName.of("FontDescriptor"))));
    this.#readStyleFromName();

    if (this.composite) {
      const encoding = resolve(context, dict.get(PDFName.of("Encoding")));
      const encodingName = encoding instanceof PDFName ? encoding.decodeText() : undefined;
      if (encodingName === "Identity-H" || encodingName === "Identity-V") {
        this.#encoding = identityCMap();
      } else if (encoding && !(encoding instanceof PDFName)) {
        const stream = streamOf(context, encoding);
        const bytes = stream && streamBytes(stream);
        if (bytes) this.#encoding = parseCMap(bytes);
        if (this.#encoding?.codespaces.length === 0) this.#encoding = undefined;
      }
      const wmode = numberOf(context, dictOf(context, encoding)?.get(PDFName.of("WMode")));
      this.vertical = encodingName?.endsWith("-V") === true || wmode === 1;
      this.decodable = this.#encoding !== undefined;
      this.scale = 0.001;
      if (descendant) this.#readCidMetrics(context, descendant);
    } else {
      this.vertical = false;
      this.decodable = true;
      this.scale = this.subtype === "Type3" ? this.#type3Scale(context) : 0.001;
      this.#readSimpleMetrics(context);
    }

    const toUnicode = streamOf(context, dict.get(PDFName.of("ToUnicode")));
    const toUnicodeBytes = toUnicode && streamBytes(toUnicode);
    if (toUnicodeBytes) this.#toUnicode = parseCMap(toUnicodeBytes);

    if (this.composite && this.program?.kind === "TrueType") {
      this.cidToGid = this.#readCidToGid(context, descriptorOwner);
    }
  }

  get embedded(): boolean {
    return this.program !== undefined;
  }

  /** Splits a string operand into character codes. */
  readCodes(bytes: Uint8Array): CodeRead[] {
    const codes: CodeRead[] = [];
    if (!this.composite) {
      for (const byte of bytes) codes.push({ code: byte, length: 1 });
      return codes;
    }
    const cmap = this.#encoding;
    if (!cmap) return codes;
    for (let offset = 0; offset < bytes.length; ) {
      const read = cmap.readCode(bytes, offset);
      codes.push(read);
      offset += read.length;
    }
    return codes;
  }

  /** Byte length a code takes in this font's strings. */
  codeLength(code: number): number {
    return this.composite ? (this.#encoding?.codeLength(code) ?? 2) : 1;
  }

  cid(code: number): number {
    if (!this.composite) return code;
    return this.#encoding?.cid(code) ?? code;
  }

  /** Horizontal advance of a code in glyph space (multiply by `scale` for text space). */
  width(code: number): number {
    if (this.composite) {
      const cid = this.cid(code);
      for (const range of this.#cidWidths) if (cid >= range.from && cid <= range.to) return range.width;
      return this.#defaultWidth;
    }
    const width = this.#widths.get(code);
    if (width !== undefined) return width;
    if (this.#standardMetrics && this.#glyphNames) {
      const glyph = this.#glyphNames[code];
      const metric = glyph ? this.#standardMetrics.getWidthOfGlyph(glyph) : undefined;
      if (typeof metric === "number") return metric;
    }
    return this.#defaultWidth;
  }

  /** Text a code stands for, if the font says. */
  unicode(code: number): string | undefined {
    const mapped = this.#toUnicode?.unicode.get(code);
    if (mapped !== undefined && mapped !== "\u0000") return mapped;
    const recovered = this.#programUnicode?.get(code);
    if (recovered !== undefined) return recovered;
    if (this.composite) return undefined;
    const symbol = this.#symbolUnicode?.get(code);
    if (symbol !== undefined) return symbol;
    const glyph = this.#glyphNames?.[code];
    return glyph ? glyphNameToUnicode(glyph) : undefined;
  }

  /** Every code the font maps to text, for building the inverse map. */
  mappedCodes(): number[] {
    const codes = new Set<number>(this.#toUnicode ? [...this.#toUnicode.unicode.keys()] : []);
    for (const code of this.#programUnicode?.keys() ?? []) codes.add(code);
    if (!this.composite) for (let code = 0; code < 256; code++) if (this.unicode(code) !== undefined) codes.add(code);
    return [...codes];
  }

  #programUnicode: Map<number, string> | undefined;

  /** Text read from the font program itself, for fonts without a ToUnicode map. */
  setProgramUnicode(map: Map<number, string>): void {
    this.#programUnicode = map;
  }

  get hasToUnicode(): boolean {
    return (this.#toUnicode?.unicode.size ?? 0) > 0;
  }

  // ── Simple fonts ─────────────────────────────────────────────────────────

  #readSimpleMetrics(context: PDFContext): void {
    const { dict } = this;
    const firstChar = numberOf(context, dict.get(PDFName.of("FirstChar")));
    const widths = numbersOf(context, dict.get(PDFName.of("Widths")));
    widths?.forEach((width, i) => this.#widths.set(firstChar + i, width));

    const standard = standardFontName(this.name);
    if (!widths && standard) this.#standardMetrics = standardFont(standard).font;
    if (standard === "Symbol" || standard === "ZapfDingbats") {
      const encoding = standardFont(standard).encoding;
      this.#symbolUnicode = new Map(
        encoding.supportedCodePoints.map((cp) => [encoding.encodeUnicodeCodePoint(cp).code, String.fromCodePoint(cp)]),
      );
    }
    this.#glyphNames = this.#readEncoding(context, standard);
  }

  #readEncoding(context: PDFContext, standard: string | undefined): string[] {
    const encoding = resolve(context, this.dict.get(PDFName.of("Encoding")));
    let base: EncodingName | undefined;
    let differences: PDFArray | undefined;
    if (encoding instanceof PDFName) {
      base = knownEncoding(encoding.decodeText());
    } else if (encoding instanceof PDFDict) {
      base = knownEncoding(nameOf(context, encoding.get(PDFName.of("BaseEncoding"))));
      differences = arrayOf(context, encoding.get(PDFName.of("Differences")));
    }
    // Without an encoding, Latin fonts use the standard one; symbolic fonts
    // use one built into the font program, which is not known here.
    const symbolic = standard === "Symbol" || standard === "ZapfDingbats" || (this.symbolic && !standard);
    const names = [...ENCODINGS[base ?? "StandardEncoding"]];
    if (symbolic && !base) names.fill("");

    if (differences) {
      let code = 0;
      for (let i = 0; i < differences.size(); i++) {
        const item = resolve(context, differences.get(i));
        if (item instanceof PDFName) {
          if (code >= 0 && code < 256) names[code] = item.decodeText();
          code++;
        } else {
          code = numberOf(context, item, code);
        }
      }
    }
    return names;
  }

  #type3Scale(context: PDFContext): number {
    const matrix = numbersOf(context, this.dict.get(PDFName.of("FontMatrix")));
    const firstChar = numberOf(context, this.dict.get(PDFName.of("FirstChar")));
    numbersOf(context, this.dict.get(PDFName.of("Widths")))?.forEach((w, i) => this.#widths.set(firstChar + i, w));
    const bbox = numbersOf(context, this.dict.get(PDFName.of("FontBBox")));
    const sy = matrix?.[3] ?? 0.001;
    if (bbox && bbox.length === 4 && sy !== 0) {
      this.ascent = Math.max(bbox[1], bbox[3]) * sy;
      this.descent = Math.min(bbox[1], bbox[3]) * sy;
    }
    return matrix?.[0] ?? 0.001;
  }

  // ── Composite fonts ──────────────────────────────────────────────────────

  #readCidMetrics(context: PDFContext, descendant: PDFDict): void {
    this.#defaultWidth = numberOf(context, descendant.get(PDFName.of("DW")), 1000);
    const w = arrayOf(context, descendant.get(PDFName.of("W")));
    if (!w) return;
    for (let i = 0; i < w.size(); ) {
      const first = numberOf(context, w.get(i));
      const next = resolve(context, w.get(i + 1));
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k++) {
          const width = numberOf(context, next.get(k));
          this.#cidWidths.push({ from: first + k, to: first + k, width });
        }
        i += 2;
      } else {
        const last = numberOf(context, next);
        const width = numberOf(context, w.get(i + 2));
        this.#cidWidths.push({ from: first, to: last, width });
        i += 3;
      }
    }
  }

  #readCidToGid(context: PDFContext, descendant: PDFDict): "identity" | Uint16Array | undefined {
    const value = resolve(context, descendant.get(PDFName.of("CIDToGIDMap")));
    if (value === undefined || (value instanceof PDFName && value.decodeText() === "Identity")) return "identity";
    const stream = streamOf(context, value);
    const bytes = stream && streamBytes(stream);
    if (!bytes) return undefined;
    const table = new Uint16Array(bytes.length >> 1);
    for (let i = 0; i < table.length; i++) table[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
    return table;
  }

  // ── Descriptor and style ─────────────────────────────────────────────────

  #readDescriptor(context: PDFContext, descriptor: PDFDict | undefined): void {
    const standard = standardFontName(this.name);
    const metrics = standard ? standardFont(standard).font : undefined;
    if (this.subtype !== "Type3") {
      const ascent = descriptor ? numberOf(context, descriptor.get(PDFName.of("Ascent"))) : 0;
      const descent = descriptor ? numberOf(context, descriptor.get(PDFName.of("Descent"))) : 0;
      const a = ascent > 0 ? ascent : (metrics?.Ascender ?? 800) || 800;
      const d = descent < 0 ? descent : (metrics?.Descender ?? -200) || -200;
      // Some files carry bogus metrics; keep the box within a sane range.
      this.ascent = Math.min(Math.max(a, 500), 1300) / 1000;
      this.descent = Math.max(Math.min(d, -50), -600) / 1000;
    }
    if (!this.composite && descriptor) {
      const missing = numberOf(context, descriptor.get(PDFName.of("MissingWidth")), Number.NaN);
      if (Number.isFinite(missing)) this.#defaultWidth = missing;
    }
    if (!descriptor) {
      this.serif = metrics?.FamilyName === "Times";
      this.monospace = metrics?.FamilyName === "Courier";
      return;
    }

    const flags = numberOf(context, descriptor.get(PDFName.of("Flags")));
    this.monospace = (flags & 1) !== 0;
    this.serif = (flags & 2) !== 0;
    this.symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    this.italic = (flags & 64) !== 0 || numberOf(context, descriptor.get(PDFName.of("ItalicAngle"))) !== 0;
    this.bold = (flags & 0x40000) !== 0 || numberOf(context, descriptor.get(PDFName.of("FontWeight"))) >= 600;

    const fontFile = streamOf(context, descriptor.get(PDFName.of("FontFile")));
    const fontFile2 = streamOf(context, descriptor.get(PDFName.of("FontFile2")));
    const fontFile3 = streamOf(context, descriptor.get(PDFName.of("FontFile3")));
    if (fontFile2) {
      this.program = { kind: "TrueType", stream: fontFile2 };
    } else if (fontFile3) {
      const sub = nameOf(context, fontFile3.dict.get(PDFName.of("Subtype")));
      this.program = { kind: sub === "OpenType" ? "OpenType" : "CFF", stream: fontFile3 };
    } else if (fontFile) {
      this.program = { kind: "Type1", stream: fontFile };
    }
  }

  #readStyleFromName(): void {
    const style = this.name.toLowerCase();
    const parts = style.split(/[-,]/).slice(1).join(" ") || style;
    if (/bold|black|heavy|semibold|demi|extrabold|ultrabold/.test(parts)) this.bold = true;
    if (/italic|oblique|slanted|kursiv/.test(parts)) this.italic = true;
    if (/courier|mono|consol|menlo|typewriter|fixed/.test(style)) this.monospace = true;
    if (/times|serif|georgia|garamond|cambria|palatino|bookman|book ?antiqua|minion|caslon|baskerville|didot|bodoni|century|roman/.test(style) && !/sans/.test(style)) {
      this.serif = true;
    }
    if (/sans|arial|helvetica|verdana|calibri|segoe|tahoma|roboto|open ?sans|lato|frutiger|myriad|futura|gill/.test(style)) {
      this.serif = false;
    }
  }

  /** Family names to try in CSS, from the most to the least specific. */
  cssFamilies(): string[] {
    const base = this.name.split(/[-,+]/)[0].replace(/(PSMT|PS|MT|Std|Pro|LT)$/, "");
    const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2");
    return [...new Set([base, spaced].filter((name) => name.length > 1))];
  }
}

function knownEncoding(name: string | undefined): EncodingName | undefined {
  return name === "StandardEncoding" || name === "WinAnsiEncoding" || name === "MacRomanEncoding" ? name : undefined;
}

const STANDARD_ALIASES: [RegExp, string][] = [
  [/^(helvetica|arial)/, "Helvetica"],
  [/^(times|timesnewroman)/, "Times-Roman"],
  [/^(courier|couriernew)/, "Courier"],
  [/^symbol/, "Symbol"],
  [/^zapfdingbats/, "ZapfDingbats"],
];

/** The standard 14 font a font name refers to (also via common aliases). */
export function standardFontName(name: string): StandardName | undefined {
  const lower = name.toLowerCase().replace(/[\s_]/g, "");
  const entry = STANDARD_ALIASES.find(([pattern]) => pattern.test(lower));
  if (!entry) return undefined;
  const family = entry[1];
  if (family === "Symbol" || family === "ZapfDingbats") return family;
  const bold = /bold|black|heavy/.test(lower);
  const italic = /italic|oblique/.test(lower);
  if (family === "Times-Roman") {
    if (bold && italic) return "Times-BoldItalic";
    if (bold) return "Times-Bold";
    if (italic) return "Times-Italic";
    return "Times-Roman";
  }
  const suffix = bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "";
  return `${family}${suffix}` as StandardName;
}

/** Fonts of a resource dictionary are loaded once per document. */
export class FontCache {
  readonly #byKey = new Map<string, PdfFont>();
  readonly #inline = new WeakMap<PDFObject, PdfFont>();
  #inlineCount = 0;
  constructor(private readonly context: PDFContext) {}

  get(object: PDFObject): PdfFont | undefined {
    try {
      if (object instanceof PDFRef) {
        const key = object.toString();
        let font = this.#byKey.get(key);
        if (!font) {
          font = new PdfFont(this.context, object, key);
          this.#byKey.set(key, font);
        }
        return font;
      }
      let font = this.#inline.get(object);
      if (!font) {
        font = new PdfFont(this.context, object, `inline-${++this.#inlineCount}`);
        this.#inline.set(object, font);
      }
      return font;
    } catch (error) {
      console.warn("No se pudo leer una fuente del PDF:", error);
      return undefined;
    }
  }
}
