/**
 * Page numbers, header, footer and watermark. They are not stored on the
 * pages: for each page they become Fabric text objects that are painted over
 * the page in the editor and drawn into the PDF on export exactly like the
 * user's own text, so what is seen is what gets exported.
 */

export type DecorationAlign = "left" | "center" | "right";
export type NumberPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface PageDecorations {
  numbers: {
    enabled: boolean;
    position: NumberPosition;
    /** Text with {n} (page number) and {N} (total), e.g. "{n} / {N}". */
    format: string;
    /** Number shown on the first decorated page. */
    startAt: number;
  };
  header: { text: string; align: DecorationAlign };
  footer: { text: string; align: DecorationAlign };
  watermark: {
    text: string;
    color: string;
    /** 0–1. */
    opacity: number;
    /** Across the page, from the lower left corner to the upper right one. */
    diagonal: boolean;
  };
  /** Numbers, header and footer start on this page (1-based); the watermark covers every page. */
  fromPage: number;
  fontSize: number;
  color: string;
  /** Distance from the edges of the page, in points. */
  margin: number;
}

export const DEFAULT_DECORATIONS: PageDecorations = {
  numbers: { enabled: true, position: "bottom-center", format: "{n} / {N}", startAt: 1 },
  header: { text: "", align: "center" },
  footer: { text: "", align: "left" },
  watermark: { text: "", color: "#9e9e9e", opacity: 0.25, diagonal: true },
  fromPage: 1,
  fontSize: 10,
  color: "#333333",
  margin: 28,
};

/** CSS stack of Helvetica, which the export maps to the standard PDF font. */
const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

export interface DecorationContext {
  /** 0-based position of the page in the document. */
  index: number;
  total: number;
  width: number;
  height: number;
  /** Document name and date for {nombre} / {fecha}. */
  name: string;
  date: string;
  /** Measures the width of a text at a font size, for sizing the watermark. */
  measure?: (text: string, fontSize: number, bold: boolean) => number;
}

/** Whether decorations draw anything at all. */
export function hasDecorations(decorations: PageDecorations | null | undefined): decorations is PageDecorations {
  return (
    !!decorations &&
    (decorations.numbers.enabled ||
      decorations.header.text.trim() !== "" ||
      decorations.footer.text.trim() !== "" ||
      decorations.watermark.text.trim() !== "")
  );
}

/** Fills {n}, {N}, {fecha}/{date} and {nombre}/{name}. */
export function fillTokens(text: string, number: number, total: number, name: string, date: string): string {
  return text
    .replaceAll("{n}", String(number))
    .replaceAll("{N}", String(total))
    .replaceAll(/\{(fecha|date)\}/g, date)
    .replaceAll(/\{(nombre|name)\}/g, name);
}

function textObject(
  text: string,
  props: { left: number; top: number; originX: DecorationAlign; originY: "top" | "center" | "bottom" },
  style: { fontSize: number; fill: string; opacity?: number; angle?: number; fontWeight?: string },
): Record<string, unknown> {
  return {
    type: "Text",
    text,
    fontFamily: FONT,
    fontWeight: style.fontWeight ?? "normal",
    fontStyle: "normal",
    fontSize: style.fontSize,
    fill: style.fill,
    opacity: style.opacity ?? 1,
    angle: style.angle ?? 0,
    textAlign: props.originX,
    lineHeight: 1.16,
    ...props,
    selectable: false,
    evented: false,
    ytaKind: "decoration",
  };
}

/** Approximate width of Helvetica text, when nothing can measure it. */
function estimateWidth(text: string, fontSize: number, bold: boolean): number {
  return text.length * fontSize * (bold ? 0.62 : 0.55);
}

/**
 * The objects that decorate one page, in its scene coordinates (the page as
 * the editor shows it, rotation and crop included).
 */
export function decorationObjects(decorations: PageDecorations, context: DecorationContext): Record<string, unknown>[] {
  const { index, total, width, height, name, date } = context;
  const objects: Record<string, unknown>[] = [];
  const style = { fontSize: decorations.fontSize, fill: decorations.color };
  const margin = decorations.margin;
  const x = (align: DecorationAlign) => (align === "left" ? margin : align === "right" ? width - margin : width / 2);

  const watermark = decorations.watermark.text.trim();
  if (watermark) {
    const angle = decorations.watermark.diagonal ? (-Math.atan2(height, width) * 180) / Math.PI : 0;
    const span = decorations.watermark.diagonal ? Math.hypot(width, height) * 0.7 : width * 0.8;
    const measure = context.measure ?? estimateWidth;
    // Sized so the text fills most of the diagonal, whatever its length.
    const fontSize = Math.max(12, Math.min(200, (span / Math.max(1, measure(watermark, 100, true))) * 100));
    objects.push(
      textObject(
        watermark,
        { left: width / 2, top: height / 2, originX: "center", originY: "center" },
        {
          fontSize: Math.round(fontSize * 10) / 10,
          fill: decorations.watermark.color,
          opacity: decorations.watermark.opacity,
          angle,
          fontWeight: "bold",
        },
      ),
    );
  }

  const first = Math.max(1, Math.floor(decorations.fromPage)) - 1;
  if (index < first) return objects;
  const number = decorations.numbers.startAt + (index - first);
  const decoratedTotal = total - first + decorations.numbers.startAt - 1;
  const fill = (text: string) => fillTokens(text, number, decoratedTotal, name, date);

  if (decorations.header.text.trim()) {
    const align = decorations.header.align;
    objects.push(textObject(fill(decorations.header.text), { left: x(align), top: margin, originX: align, originY: "top" }, style));
  }
  if (decorations.footer.text.trim()) {
    const align = decorations.footer.align;
    objects.push(
      textObject(fill(decorations.footer.text), { left: x(align), top: height - margin, originX: align, originY: "bottom" }, style),
    );
  }
  if (decorations.numbers.enabled) {
    const [vertical, horizontal] = decorations.numbers.position.split("-") as ["top" | "bottom", string];
    const align = (horizontal === "center" ? "center" : horizontal) as DecorationAlign;
    objects.push(
      textObject(
        fill(decorations.numbers.format),
        { left: x(align), top: vertical === "top" ? margin : height - margin, originX: align, originY: vertical },
        style,
      ),
    );
  }
  return objects;
}

let measuringContext: CanvasRenderingContext2D | null = null;

/** Measures with the browser's Helvetica-compatible font (the same the canvas uses). */
export function measureText(text: string, fontSize: number, bold: boolean): number {
  if (typeof document === "undefined") return estimateWidth(text, fontSize, bold);
  measuringContext ??= document.createElement("canvas").getContext("2d");
  if (!measuringContext) return estimateWidth(text, fontSize, bold);
  measuringContext.font = `${bold ? "bold " : ""}${fontSize}px ${FONT}`;
  return measuringContext.measureText(text).width;
}
