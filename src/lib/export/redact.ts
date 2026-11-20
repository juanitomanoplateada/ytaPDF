import { PDFArray, PDFDict, PDFName, PDFRef, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";
import { IDENTITY } from "../geometry";
import { applyNativeSpecs, type ApplyResources } from "../pdfText/apply";
import type { FontCache } from "../pdfText/fonts";
import { glyphQuad, interpretPage, type Glyph, type PaintedArea } from "../pdfText/interpreter";
import { numbersOf } from "../pdfText/pdfObjects";
import { compressRanges } from "../pdfText/ranges";
import type { NativeSpec } from "../pdfText/types";
import { centroid, insideConvex, overlapArea, polygonArea, type Point } from "../polygon";

/**
 * Real redaction without turning the page into an image: whatever lies under
 * the boxes is removed from the page's content (text, shapes, images that fit
 * inside a box, annotations), and the boxes are then drawn on top. When
 * something cannot be cut exactly (an image partly under a box, a form field,
 * content that cannot be read), the caller exports the page as an image.
 */

export type RedactionOutcome =
  | { done: true; glyphs: number; shapes: number; images: number; annotations: number }
  | { done: false; reason: "image" | "field" | "unreadable" };

/** Share of a glyph's box that must be under a redaction box for the glyph to go. */
const GLYPH_SHARE = 0.2;
/** Points (1/72 in) a shape may stick out of a box and still count as inside. */
const TOLERANCE = 0.75;
/** Overlap (square points) below which an image only touches a box. */
const TOUCH_AREA = 0.5;

/** What has to change on a page so nothing under `areas` (convex polygons, user space) remains. */
export interface RedactionPlan {
  glyphs: Glyph[];
  drop: Set<string>;
  images: number;
  shapes: number;
  /** Indices in the page's /Annots of the annotations to remove. */
  annotations: number[];
  blocked?: "image" | "field";
}

const touches = (quad: Point[], areas: Point[][], share: number) => {
  const area = polygonArea(quad);
  if (area < 1e-6) {
    const center = centroid(quad);
    return areas.some((zone) => insideConvex(center, zone));
  }
  return areas.some((zone) => overlapArea(quad, zone) >= area * share);
};

const insideAny = (points: Point[], areas: Point[][]) =>
  points.length > 0 && areas.some((zone) => points.every((point) => insideConvex(point, zone, TOLERANCE)));

export function planRedaction(
  glyphs: Glyph[],
  paints: PaintedArea[],
  annotations: { subtype: string | undefined; rect: Point[] | null }[],
  areas: Point[][],
): RedactionPlan {
  const plan: RedactionPlan = { glyphs: [], drop: new Set(), images: 0, shapes: 0, annotations: [] };
  for (const glyph of glyphs) {
    if (touches(glyphQuad(glyph) as Point[], areas, GLYPH_SHARE)) plan.glyphs.push(glyph);
  }
  for (const paint of paints) {
    if (paint.kind === "shading") continue;
    if (insideAny(paint.points, areas)) {
      plan.drop.add(paint.key);
      if (paint.kind === "image") plan.images++;
      else plan.shapes++;
    } else if (paint.kind === "image" && areas.some((zone) => overlapArea(paint.points, zone) > TOUCH_AREA)) {
      plan.blocked ??= "image";
    }
  }
  annotations.forEach((annotation, index) => {
    if (!annotation.rect || !areas.some((zone) => overlapArea(annotation.rect!, zone) > TOUCH_AREA)) return;
    if (annotation.subtype === "Widget") plan.blocked = "field";
    else plan.annotations.push(index);
  });
  return plan;
}

function rectCorners(page: PDFPage, value: PDFObject | undefined): Point[] | null {
  const n = numbersOf(page.doc.context, value);
  if (!n || n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [x0, y0, x1, y1] = n;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

interface PageAnnotation {
  subtype: string | undefined;
  rect: Point[] | null;
  dict: PDFDict | undefined;
}

function annotationsOf(page: PDFPage): { array: PDFArray | undefined; list: PageAnnotation[] } {
  const { context } = page.doc;
  const raw = page.node.get(PDFName.of("Annots"));
  const array = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (!(array instanceof PDFArray)) return { array: undefined, list: [] };
  const list: PageAnnotation[] = [];
  for (let i = 0; i < array.size(); i++) {
    const dict = context.lookup(array.get(i));
    if (!(dict instanceof PDFDict)) {
      list.push({ subtype: undefined, rect: null, dict: undefined });
      continue;
    }
    const subtype = dict.lookup(PDFName.of("Subtype"));
    list.push({
      subtype: subtype instanceof PDFName ? subtype.decodeText() : undefined,
      rect: rectCorners(page, dict.get(PDFName.of("Rect"))),
      dict,
    });
  }
  return { array, list };
}

/** Removes the annotations at `indices` of the page's /Annots, with their pop-up windows. */
function removeAnnotations(page: PDFPage, array: PDFArray, list: PageAnnotation[], indices: number[]): void {
  const removed = new Set<PDFDict>();
  // Only annotations with a rectangle are removed, and only dictionaries have one.
  for (const index of indices) removed.add(list[index].dict!);
  const popups: PDFDict[] = [];
  for (const dict of removed) {
    const popup = dict.lookup(PDFName.of("Popup"));
    if (popup instanceof PDFDict) popups.push(popup);
  }
  for (const popup of popups) removed.add(popup);
  const goes = (dict: PDFDict | undefined) => {
    const parent = dict?.lookup(PDFName.of("Parent"));
    return !!dict && (removed.has(dict) || (parent instanceof PDFDict && removed.has(parent)));
  };
  const kept = page.doc.context.obj([]);
  for (let i = 0; i < array.size(); i++) {
    if (!goes(list[i].dict)) kept.push(array.get(i));
  }
  if (kept.size() > 0) page.node.set(PDFName.of("Annots"), kept);
  else page.node.delete(PDFName.of("Annots"));
}

/**
 * Removes from `page` everything under `areas` (convex polygons in the page's
 * user space). Nothing is changed when the outcome is not `done`.
 */
export async function redactPage(
  page: PDFPage,
  areas: Point[][],
  fonts: FontCache,
  resources: ApplyResources,
): Promise<RedactionOutcome> {
  const content = interpretPage(page, fonts, { trackCtm: true, trackPaints: true });
  if (!content.complete) return { done: false, reason: "unreadable" };
  const annotations = annotationsOf(page);
  const plan = planRedaction(content.glyphs, content.paints, annotations.list, areas);
  if (plan.blocked) return { done: false, reason: plan.blocked };

  if (plan.glyphs.length > 0 || plan.drop.size > 0) {
    const spec: NativeSpec = {
      id: "redaction",
      erase: compressRanges(plan.glyphs),
      insertAfter: "end",
      matrix: IDENTITY,
      renderMode: 0,
      runs: [],
      underlines: [],
    };
    const report = await applyNativeSpecs(page, [spec], fonts, resources, { drop: plan.drop, content });
    if (report.failed.length > 0) return { done: false, reason: "unreadable" };
  }
  if (annotations.array && plan.annotations.length > 0) removeAnnotations(page, annotations.array, annotations.list, plan.annotations);

  // A stored thumbnail would still show the page as it was.
  page.node.delete(PDFName.of("Thumb"));
  return {
    done: true,
    glyphs: plan.glyphs.length,
    shapes: plan.shapes,
    images: plan.images,
    annotations: plan.annotations.length,
  };
}
