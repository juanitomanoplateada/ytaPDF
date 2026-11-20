import { describe, expect, it } from "vitest";
import { formatOperand, formatOperation, isName, isString, latin1, parseContent, type Operand } from "./lexer";

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const parse = (text: string) => parseContent(bytes(text));
const operandsOf = (text: string) => parse(text)[0].operands;
const str = (operand: Operand) => latin1((operand as { bytes: Uint8Array }).bytes);

describe("content stream lexer", () => {
  it("skips comments, stray delimiters and closing brackets between operations", () => {
    const ops = parse("% comentario\r1 0 0 1 0 0 cm ] >> ) { } % otro\nq");
    expect(ops.map((op) => op.op)).toEqual(["cm", "q"]);
  });

  it("reads numbers the way viewers do", () => {
    expect(operandsOf("--5 +.5 -.5- 1.2.3 - . Td")).toEqual([-5, 0.5, -0.5, 1.2, 0, 0]);
  });

  it("reads booleans, null, names with escapes and keywords", () => {
    expect(operandsOf("true false null /A#20B#2f /Sin#zz op")).toEqual([
      true,
      false,
      null,
      { kind: "name", value: "A B/" },
      { kind: "name", value: "Sin#zz" },
    ]);
  });

  it("reads literal strings with nesting, escapes, octal codes and line ends", () => {
    const [nested, escapes, octal, ends, other] = operandsOf(
      "(a(b)c) (\\n\\r\\t\\b\\f\\\\\\)) (\\101\\1\\0777) (x\\\r\ny\\\nz\r\nw\rv) (\\q) Tj",
    );
    expect(str(nested)).toBe("a(b)c");
    expect(str(escapes)).toBe("\n\r\t\b\f\\)");
    expect(str(octal)).toBe("A\u0001?7");
    expect(str(ends)).toBe("xyz\nw\nv");
    expect(str(other)).toBe("q");
  });

  it("ends a string that runs into the end of the stream", () => {
    expect(parse("(abc\\")).toEqual([]);
    expect(parse("(abc")).toEqual([]);
  });

  it("reads hex strings, padding odd digits and skipping other characters", () => {
    const [even, odd, unterminated] = operandsOf("<48 65 6C6c> <414> Tj <41");
    expect(str(even)).toBe("Hell");
    expect(str(odd)).toBe("A@");
    expect(unterminated).toBeUndefined();
    expect(parse("<41 zz 42> Tj")[0].operands.map(str)).toEqual(["AB"]);
  });

  it("reads arrays and dictionaries, ignoring what does not belong in them", () => {
    const [array, dict] = operandsOf("[1 >> foo (a) [2]] << 5 /A 1 null (x) [1] ] key /B 2 /C << /D 3 >> >> BDC");
    expect(array).toEqual([1, { kind: "string", bytes: bytes("a") }, [2]]);
    expect(dict).toEqual({
      kind: "dict",
      entries: new Map<string, Operand>([
        ["A", 1],
        ["B", 2],
        ["C", { kind: "dict", entries: new Map([["D", 3]]) }],
      ]),
    });
  });

  it("closes arrays and dictionaries left open at the end", () => {
    expect(parse("[1 2")).toEqual([]);
    expect(parse("<< /A 1")).toEqual([]);
  });

  it("reads inline images and skips their data up to the real EI", () => {
    const ops = parse("q BI /W 2 /H 1 5 ] >> foo /CS /G ID \u0000EI\u0001\u0002 EI Q");
    expect(ops.map((op) => op.op)).toEqual(["q", "BI", "Q"]);
    expect(ops[1].operands).toEqual([
      {
        kind: "dict",
        entries: new Map<string, Operand>([
          ["W", 2],
          ["H", 1],
          ["CS", { kind: "name", value: "G" }],
        ]),
      },
    ]);
  });

  it("takes an EI at the very end, and the rest of the stream when there is none", () => {
    expect(parse("BI /W 1 IDxyzEI").map((op) => op.op)).toEqual(["BI"]);
    const unterminated = parse("BI /W 1 ID \u0001\u0002\u0003");
    expect(unterminated).toHaveLength(1);
    expect(unterminated[0].end).toBe(14);
    expect(parse("BI /W 1").map((op) => op.op)).toEqual(["BI"]);
  });

  it("does not take an EI followed by binary bytes as the end of the data", () => {
    const ops = parse("BI /W 1 ID \u0000EI ÿ EI \u0001 EI\nQ");
    expect(ops.map((op) => op.op)).toEqual(["BI", "Q"]);
  });

  it("reads a lone > as the end of a dictionary", () => {
    expect(parse("1 > Q")).toEqual([{ op: "Q", operands: [1], start: 0, end: 5 }]);
  });
});

describe("writing operands", () => {
  it("formats every kind of operand", () => {
    const dict: Operand = { kind: "dict", entries: new Map<string, Operand>([["Nombre raro#", { kind: "name", value: "ñ(x)" }]]) };
    expect([Number.NaN, Infinity, -0.0000001, 1.0000001, 1.5, 7].map((n) => formatOperand(n))).toEqual(["0", "0", "0", "1", "1.5", "7"]);
    expect(formatOperand(null)).toBe("null");
    expect(formatOperand(true)).toBe("true");
    expect(formatOperand(false)).toBe("false");
    expect(formatOperand([1.5, { kind: "string", bytes: Uint8Array.of(0, 255) }])).toBe("[1.5 <00ff>]");
    expect(formatOperand(dict)).toBe("<</Nombre#20raro#23 /#f1#28x#29>>");
    expect(formatOperation("Q")).toBe("Q");
    expect(formatOperation("Tf", [{ kind: "name", value: "F1" }, 12])).toBe("/F1 12 Tf");
  });

  it("tells names and strings from other operands", () => {
    for (const value of [null, 1, [1], { kind: "dict", entries: new Map() }] as Operand[]) {
      expect(isName(value)).toBe(false);
      expect(isString(value)).toBe(false);
    }
    expect(isName({ kind: "name", value: "A" })).toBe(true);
    expect(isString({ kind: "string", bytes: new Uint8Array() })).toBe(true);
  });
});
