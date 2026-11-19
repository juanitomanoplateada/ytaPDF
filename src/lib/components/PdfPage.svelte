<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ActiveSelection, Canvas, IText, PencilBrush, type FabricObject, type TPointerEventInfo } from "fabric";
  import { TextLayer, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
  import { t } from "../i18n.svelte";
  import { search } from "../search.svelte";
  import { ocrKey, withOcrText } from "../ocrText";
  import { markLine, mergeLines } from "../textMarks";
  import { paintAnnotations } from "../thumbnails";
  import {
    alignObjects,
    distributeObjects,
    groupSelected,
    setObjectBounds,
    ungroupSelected,
  } from "../fabricSetup";
  import {
    applyShapeStyle,
    setLinkTarget,
    applyTextStyle,
    arrange,
    bakeScale,
    clearTopLayer,
    createImage,
    createMark,
    createShape,
    createSignature,
    createText,
    DEFAULT_SIZES,
    describeSelection,
    drawShapePreview,
    editableSelection,
    installAlignmentGuides,
    isLocked,
    isText,
    markInk,
    pasteObjects,
    prepareObject,
    removeObjects,
    selectedObjects,
    selectionText,
    serializeSelection,
    setLocked,
    syncSelectionLock,
  } from "../fabricSetup";
  import {
    editor,
    placedSignatureWidth,
    type DrawTool,
    type PageAnnotations,
    type PageController,
    type PageRef,
    type Rect,
  } from "../editor.svelte";
  import { ensureFontsFor, ensureScriptFontsFor } from "../embeddedFonts";
  import { applyToPoint, type Matrix } from "../geometry";
  import { importImage } from "../images";
  import {
    createNativeText,
    isNative,
    markDeleted,
    nativeSpec,
    pointInQuad,
    toScene,
    type NativeText,
  } from "../nativeText";
  import { notifications } from "../notifications.svelte";
  import { isRenderCancelled, pageTextContent, renderPage, viewportOf } from "../pdfjs";
  import { parseEraseRanges } from "../pdfText/ranges";
  import { specKey, textEditing, type PreviewHandle } from "../pdfText/service";
  import type { NativeSpec, PageTextAnalysis, Point, TextUnit } from "../pdfText/types";
  import FormLayer from "./FormLayer.svelte";

  interface Props {
    page: PageRef;
    index: number;
    /** Whether the page is close enough to the viewport to be rendered. */
    active: boolean;
  }

  let { page, index, active }: Props = $props();

  const DRAW_TOOLS: DrawTool[] = ["rect", "ellipse", "line", "arrow", "highlight", "redact", "note", "link"];
  const isDrawTool = (tool: string): tool is DrawTool => DRAW_TOOLS.includes(tool as DrawTool);

  let container: HTMLDivElement;
  let pdfCanvas = $state<HTMLCanvasElement>();
  let fabricElement = $state<HTMLCanvasElement>();
  let pdfPage = $state.raw<PDFPageProxy | null>(null);
  let rendered = $state(false);
  /** Bumped whenever a Fabric canvas is created, so effects can react to it. */
  let canvasGeneration = $state(0);

  // Fabric objects are deliberately kept out of Svelte's reactivity.
  let canvas: Canvas | null = null;
  let lastSynced: PageAnnotations | undefined;
  let loading = false;
  let loadAbort: AbortController | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveKey: string | undefined;
  let pendingTextAt: { x: number; y: number } | null = null;
  let drawStart: { x: number; y: number } | null = null;
  let cropStart: { x: number; y: number } | null = null;
  /** Area being drawn with the crop tool. */
  let cropDraft = $state<Rect | null>(null);
  let cleanups: Array<() => void> = [];

  const width = $derived(page.width * editor.zoom);
  const height = $derived(page.height * editor.zoom);
  /** The crop area shown over this page: the one being drawn, or the one waiting to be applied. */
  const cropArea = $derived(
    cropDraft ?? (editor.pendingCrop?.pageId === page.id && editor.tool === "crop" ? editor.pendingCrop.rect : null),
  );

  // ── Text layer, search and decorations ────────────────────────────────────

  let textLayerElement = $state<HTMLDivElement>();
  /** Spans of the text layer, one per text item of the page. */
  let textDivs = $state.raw<HTMLElement[]>([]);
  let decorationCanvas = $state<HTMLCanvasElement>();
  let highlights = $state.raw<{ left: number; top: number; width: number; height: number; active: boolean }[]>([]);

  // PDF.js lays out the transparent text over the page; the zoom only changes a CSS variable.
  $effect(() => {
    const proxy = pdfPage;
    const element = textLayerElement;
    const geometry = { rotation: page.rotation, crop: page.crop };
    // Text recognised on a scanned page is selectable and searchable like the rest.
    const recognised = editor.ocr[ocrKey(page.sourceId, page.sourceIndex)];
    if (!proxy || !element) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    element.replaceChildren();
    textDivs = [];
    void pageTextContent(proxy)
      .then((content) => {
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: withOcrText(content, recognised),
          container: element,
          viewport: viewportOf(proxy, 1, geometry),
        });
        return layer.render().then(() => {
          if (!cancelled && layer) textDivs = layer.textDivs;
        });
      })
      .catch((error) => {
        if (!cancelled) console.error("No se pudo preparar el texto de la página:", error);
      });
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  });

  /** Boxes of a text range on this page, in scene units, from the text layer's spans. */
  function rangeBoxes(range: { start: { item: number; offset: number }; end: { item: number; offset: number } }) {
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    const origin = container.getBoundingClientRect();
    for (let item = range.start.item; item <= range.end.item; item++) {
      const node = textDivs[item]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const length = node.textContent?.length ?? 0;
      const sub = document.createRange();
      sub.setStart(node, item === range.start.item ? Math.min(range.start.offset, length) : 0);
      sub.setEnd(node, item === range.end.item ? Math.min(range.end.offset + 1, length) : length);
      for (const r of sub.getClientRects()) {
        boxes.push({
          x: (r.left - origin.left) / editor.zoom,
          y: (r.top - origin.top) / editor.zoom,
          width: r.width / editor.zoom,
          height: r.height / editor.zoom,
        });
      }
    }
    return boxes;
  }

  // Search matches on this page, highlighted over the text.
  $effect(() => {
    const matches = search.matchesOn(page.id);
    void textDivs;
    void editor.zoom;
    void search.reveal;
    if (matches.length === 0 || textDivs.length === 0) {
      highlights = [];
      return;
    }
    // Measured after layout, when the spans have their final size.
    const frame = requestAnimationFrame(() => {
      highlights = matches.flatMap((match) =>
        mergeLines(rangeBoxes(match), spanRotation(textDivs[match.start.item]) % 180 !== 0).map((box) => ({
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          active: match.active,
        })),
      );
      // The new highlights reach the DOM after this update.
      void tick().then(() => {
        container.querySelector(".search-hit.active")?.scrollIntoView({ block: "center", inline: "nearest" });
      });
    });
    return () => cancelAnimationFrame(frame);
  });

  // Page numbers, header, footer and watermark, painted over the page.
  $effect(() => {
    const target = decorationCanvas;
    const objects = editor.decorationObjects[page.id] ?? [];
    const zoom = editor.zoom;
    const w = width;
    const h = height;
    if (!target || !active) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    target.width = Math.max(1, Math.round(w * ratio));
    target.height = Math.max(1, Math.round(h * ratio));
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    if (objects.length === 0) return;
    const abort = new AbortController();
    void paintAnnotations(ctx, { objects }, zoom * ratio, abort.signal).catch(() => {});
    return () => abort.abort();
  });

  /** How a span's letters are turned on screen (page rotation plus the text's own), in quarter turns. */
  function spanRotation(span: HTMLElement | undefined): number {
    const main = Number(textLayerElement?.dataset.mainRotation ?? 0);
    const own = span ? Number.parseFloat(span.style.getPropertyValue("--rotate")) || 0 : 0;
    return ((Math.round((main + own) / 90) * 90) % 360 + 360) % 360;
  }

  /** Lines of text selected on this page (scene units), and how their letters are turned. */
  function selectedLines(range: Range): { lines: { x: number; y: number; width: number; height: number }[]; rotation: number } {
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    const origin = container.getBoundingClientRect();
    let first: HTMLElement | undefined;
    for (const span of textDivs) {
      const node = span.firstChild;
      if (!node || !range.intersectsNode(span)) continue;
      first ??= span;
      const length = node.textContent?.length ?? 0;
      const sub = document.createRange();
      sub.setStart(node, span.contains(range.startContainer) && range.startContainer === node ? range.startOffset : 0);
      sub.setEnd(node, span.contains(range.endContainer) && range.endContainer === node ? range.endOffset : length);
      if (sub.collapsed) continue;
      for (const r of sub.getClientRects()) {
        boxes.push({
          x: (r.left - origin.left) / editor.zoom,
          y: (r.top - origin.top) / editor.zoom,
          width: r.width / editor.zoom,
          height: r.height / editor.zoom,
        });
      }
    }
    const rotation = spanRotation(first);
    return { lines: mergeLines(boxes, rotation % 180 !== 0), rotation };
  }

  // ── PDF layer ─────────────────────────────────────────────────────────────

  $effect(() => {
    if (!active) rendered = false;
  });

  $effect(() => {
    const source = editor.sources.get(page.sourceId);
    if (!active || !source) return;
    let cancelled = false;
    void source.pdf.getPage(page.sourceIndex + 1).then((proxy) => {
      if (!cancelled) pdfPage = proxy;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const target = pdfCanvas;
    const proxy = pdfPage;
    const zoom = editor.zoom;
    const rotation = page.rotation;
    const crop = page.crop;
    const specs = previewSpecs;
    const drawn = previewDrawn;
    const source = editor.sources.get(page.sourceId);
    // Form values reach PDF.js asynchronously; repaint when they arrive.
    void editor.formRevision[page.sourceId];
    if (!target || !proxy || !source) return;

    let cancelled = false;
    let task: RenderTask | null = null;
    let handle: PreviewHandle | null = null;
    // Render off-screen and swap, so zooming stretches the old bitmap instead
    // of flashing an empty page.
    const buffer = document.createElement("canvas");
    (async () => {
      let renderProxy = proxy;
      if (specs.length > 0) {
        // Edited document text: render the page of a preview with the changes.
        handle = textEditing.preview(source, page.sourceIndex, specs);
        const pdf = await handle.pdf;
        if (cancelled) return;
        await textEditing.syncForms(pdf, untrack(() => editor.formValues[page.sourceId] ?? {}));
        renderProxy = await pdf.getPage(page.sourceIndex + 1);
        if (cancelled) return;
      }
      task = renderPage(renderProxy, buffer, zoom, undefined, { rotation, crop });
      await task.promise;
      if (cancelled) return;
      target.width = buffer.width;
      target.height = buffer.height;
      target.getContext("2d")?.drawImage(buffer, 0, 0);
      rendered = true;
      // The preview shown stays alive until another one replaces it.
      displayedPreview?.release();
      displayedPreview = handle;
      handle = null;
      displayedErased = new Set(specs.map((spec) => spec.id));
      displayedDrawn = drawn;
      syncGhosts();
    })().catch((error) => {
      if (cancelled || isRenderCancelled(error)) return;
      console.error("Error al dibujar la página:", error);
      if (specs.length > 0) notifications.error(t("No se pudo mostrar el texto editado en la página."));
    });

    return () => {
      cancelled = true;
      task?.cancel();
      handle?.release();
    };
  });

  $effect(() => {
    // Without a rendered page there is nothing to keep a preview for.
    if (!active) {
      displayedPreview?.release();
      displayedPreview = null;
      displayedErased = new Set();
      displayedDrawn = new Map();
      masks = [];
    }
  });

  // ── Document text ─────────────────────────────────────────────────────────

  /** Specs drawn into the PDF layer, and the hash of each native object they draw. */
  let previewSpecs = $state.raw<NativeSpec[]>([]);
  let previewDrawn = new Map<string, string>();
  let previewKey = "";
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the bitmap on screen shows: the edits it erases and the ones it draws. */
  let displayedPreview: PreviewHandle | null = null;
  let displayedErased = new Set<string>();
  let displayedDrawn = new Map<string, string>();
  /** Areas painted with the page colour, over text the bitmap still shows but should not. */
  let masks: { points: Point[]; color: string }[] = [];
  /** Native objects being moved, resized or rotated. */
  const transforming = new Set<NativeText>();

  let analysis = $state.raw<PageTextAnalysis | null>(null);
  let analysisState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let hovered: TextUnit | null = null;
  /** A click made while the page's text was still being read. */
  let pendingEdit: { point: Point; lineOnly: boolean } | null = null;

  function viewportTransform(): Matrix | null {
    return pdfPage ? (viewportOf(pdfPage, 1, page).transform as Matrix) : null;
  }

  function natives(): NativeText[] {
    return canvas ? canvas.getObjects().filter(isNative) : [];
  }

  function isActive(object: NativeText): boolean {
    return canvas ? canvas.getActiveObjects().includes(object) : false;
  }

  /**
   * Recomputes what the PDF layer must show: every edit of document text is
   * erased, and the text of those not being edited is drawn by the PDF itself.
   */
  function refreshPreview(delay = 60) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const viewport = viewportTransform();
      if (!canvas || !viewport) return;
      const specs: NativeSpec[] = [];
      const drawn = new Map<string, string>();
      for (const object of natives()) {
        const draw = !isActive(object);
        const spec = nativeSpec(object, viewport, draw);
        specs.push(spec);
        if (draw && spec.runs.length > 0) drawn.set(object.ytaNative.unit, specKey(spec));
      }
      const key = specKey(specs);
      if (key === previewKey) {
        syncGhosts();
        return;
      }
      previewKey = key;
      previewDrawn = drawn;
      previewSpecs = specs;
      syncGhosts();
    }, delay);
  }

  /**
   * A native object is not drawn by Fabric while the page bitmap already
   * shows it exactly (with the document's own font); otherwise it is.
   */
  function syncGhosts() {
    const viewport = viewportTransform();
    if (!canvas || !viewport) return;
    let changed = masks.length > 0;
    const nextMasks: typeof masks = [];
    for (const object of natives()) {
      const id = object.ytaNative.unit;
      const shown = displayedDrawn.get(id);
      const ghost =
        shown !== undefined &&
        !object.isEditing &&
        !transforming.has(object) &&
        shown === specKey(nativeSpec(object, viewport, true));
      if (object.ytaGhost !== ghost) {
        object.ytaGhost = ghost;
        object.dirty = true;
        changed = true;
      }
      // The bitmap still shows the original text (or an older version of the
      // edit) under text Fabric is drawing: cover it until the preview arrives.
      const original = !displayedErased.has(id);
      const older = shown !== undefined && !transforming.has(object);
      if (!ghost && (original || older) && object.visible) {
        const color = pageColorAround(object.ytaNative.area.flat().map(([x, y]) => applyToPoint(viewport, x, y)));
        if (original) {
          for (const quad of object.ytaNative.area) nextMasks.push({ points: grow(toScene(viewport, quad), 1.5), color });
        }
        if (older) {
          const box = object.getBoundingRect();
          const corners: Point[] = [
            [box.left, box.top],
            [box.left + box.width, box.top],
            [box.left + box.width, box.top + box.height],
            [box.left, box.top + box.height],
          ];
          nextMasks.push({ points: grow(corners, 1.5), color });
        }
      }
    }
    masks = nextMasks;
    if (changed || masks.length > 0) canvas.requestRenderAll();
  }

  /** Enlarges a polygon around its centre by `by` scene units. */
  function grow(points: Point[], by: number): Point[] {
    const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    return points.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) || 1;
      return [x + (dx / d) * by, y + (dy / d) * by];
    });
  }

  /** The most common colour of the page just around some points (the paper, usually). */
  function pageColorAround(points: Point[]): string {
    const ctx = pdfCanvas?.getContext("2d", { willReadFrequently: true });
    if (!ctx || !pdfCanvas || points.length === 0) return "#ffffff";
    const scale = pdfCanvas.width / page.width / editor.zoom;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - 3, Math.max(...xs) + 3, Math.min(...ys) - 3, Math.max(...ys) + 3];
    const samples: Point[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      samples.push([minX + (maxX - minX) * t, minY], [minX + (maxX - minX) * t, maxY]);
    }
    samples.push([minX, (minY + maxY) / 2], [maxX, (minY + maxY) / 2]);
    const counts = new Map<string, number>();
    for (const [x, y] of samples) {
      const px = Math.round(x * editor.zoom * scale);
      const py = Math.round(y * editor.zoom * scale);
      if (px < 0 || py < 0 || px >= pdfCanvas.width || py >= pdfCanvas.height) continue;
      const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
      const key = `rgb(${r}, ${g}, ${b})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#ffffff";
  }

  $effect(() => {
    const source = editor.sources.get(page.sourceId);
    if (!active || !source || editor.tool !== "edit" || analysisState !== "idle") return;
    analysisState = "loading";
    textEditing
      .analyze(source, page.sourceIndex)
      .then((result) => {
        analysis = result;
        analysisState = "ready";
        const pending = pendingEdit;
        pendingEdit = null;
        if (pending && editor.tool === "edit") editTextAt(pending.point, pending.lineOnly, null);
      })
      .catch((error) => {
        console.error("No se pudo analizar el texto de la página:", error);
        analysisState = "error";
        notifications.error(t("No se pudo leer el texto de esta página para editarlo."));
      });
  });

  $effect(() => {
    if (editor.tool !== "edit" && canvas) clearHover();
  });

  /** Glyph keys already replaced by an edit on this page. */
  function takenGlyphs(): Set<string> {
    const taken = new Set<string>();
    for (const object of natives()) {
      for (const [op, indices] of parseEraseRanges(object.ytaNative.erase)) {
        for (const index of indices) taken.add(`${op}:${index}`);
      }
    }
    return taken;
  }

  function isTaken(unit: TextUnit, taken: Set<string>): boolean {
    for (const [op, indices] of parseEraseRanges(unit.erase)) {
      for (const index of indices) if (taken.has(`${op}:${index}`)) return true;
    }
    return false;
  }

  /** The line or paragraph under a scene point (a line alone with Alt). */
  function unitAt(point: Point, lineOnly: boolean): TextUnit | null {
    const viewport = viewportTransform();
    if (!analysis || !viewport) return null;
    const margin = 2 / editor.zoom;
    const index = analysis.lines.findIndex((line) =>
      line.quads.some((quad) => pointInQuad(point, toScene(viewport, quad), margin)),
    );
    if (index < 0) return null;
    const taken = takenGlyphs();
    const paragraphIndex = analysis.paragraphOf[index];
    const paragraph = paragraphIndex >= 0 ? analysis.paragraphs[paragraphIndex] : undefined;
    if (!lineOnly && paragraph && paragraph.editable && !isTaken(paragraph, taken)) return paragraph;
    const line = analysis.lines[index];
    return isTaken(line, taken) ? null : line;
  }

  function clearHover() {
    hovered = null;
    if (canvas) {
      clearTopLayer(canvas);
      canvas.setCursor(canvas.defaultCursor);
    }
  }

  /** Outlines the text that a click would turn editable. */
  function showHover(unit: TextUnit | null) {
    if (!canvas) return;
    const viewport = viewportTransform();
    if (unit === hovered) return;
    hovered = unit;
    clearTopLayer(canvas);
    if (!unit || !viewport) {
      canvas.setCursor("text");
      return;
    }
    const ctx = canvas.contextTop;
    const vpt = canvas.viewportTransform;
    const ratio = canvas.getRetinaScaling();
    ctx.save();
    ctx.setTransform(ratio * vpt[0], 0, 0, ratio * vpt[3], ratio * vpt[4], ratio * vpt[5]);
    ctx.fillStyle = unit.editable ? "rgba(25, 118, 210, 0.10)" : "rgba(229, 72, 77, 0.10)";
    ctx.strokeStyle = unit.editable ? "rgba(25, 118, 210, 0.85)" : "rgba(229, 72, 77, 0.85)";
    ctx.lineWidth = 1 / editor.zoom;
    ctx.setLineDash([4 / editor.zoom, 3 / editor.zoom]);
    for (const quad of unit.quads) {
      const points = toScene(viewport, quad);
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    canvas.setCursor(unit.editable ? "text" : "not-allowed");
  }

  /** Turns the text under the pointer into an editable object. */
  function editTextAt(point: Point, lineOnly: boolean, event: TPointerEventInfo["e"] | null): boolean {
    const viewport = viewportTransform();
    if (!canvas || !viewport || !analysis) return false;
    if (analysis.lines.length === 0) {
      notifications.info(
        t("Esta página no tiene texto que se pueda editar. Si es un documento escaneado, el texto forma parte de una imagen."),
        { label: t("Reconocer texto (OCR)"), run: () => (editor.ocrDialog = true) },
      );
      return false;
    }
    const unit = unitAt(point, lineOnly);
    if (!unit) return false;
    if (!unit.editable) {
      notifications.info(t(unit.reason ?? "Este texto no se puede editar."));
      return true;
    }
    clearHover();
    const object = createNativeText(unit, analysis, viewport);
    canvas.add(object);
    canvas.setActiveObject(object);
    object.enterEditing();
    // The caret goes where the user clicked (this also moves Fabric's hidden textarea).
    const caret = event ? object.getSelectionStartFromPointer(event) : object.text.length;
    object.setSelectionStart(caret);
    object.setSelectionEnd(caret);
    canvas.requestRenderAll();
    scheduleSave();
    reportSelection();
    refreshPreview(0);
    return true;
  }

  // ── Annotation layer ──────────────────────────────────────────────────────

  $effect(() => {
    const element = fabricElement;
    if (!element) return;
    const instance = untrack(() => createCanvas(element));
    return () => destroyCanvas(instance);
  });

  $effect(() => {
    void canvasGeneration;
    const zoom = editor.zoom;
    const w = width;
    const h = height;
    if (!canvas) return;
    canvas.setDimensions({ width: w, height: h });
    canvas.setZoom(zoom);
    canvas.calcOffset();
    canvas.requestRenderAll();
  });

  $effect(() => {
    void canvasGeneration;
    const tool = editor.tool;
    if (!canvas) return;
    const drawing = isDrawTool(tool) || tool === "crop";
    const pen = tool === "pen";
    canvas.selection = tool === "select";
    // While drawing or cropping, clicks over existing objects start a new shape.
    canvas.skipTargetFind = drawing;
    canvas.isDrawingMode = pen;
    // With the pen, a finger draws instead of scrolling the document.
    canvas.allowTouchScrolling = !pen;
    setTouchScrolling(!pen);
    canvas.defaultCursor = tool === "text" || tool === "edit" ? "text" : drawing ? "crosshair" : "default";
    if (tool !== "select") canvas.discardActiveObject();
    canvas.requestRenderAll();
  });

  // The pen draws with the current stroke colour and width.
  $effect(() => {
    void canvasGeneration;
    const pen = editor.tool === "pen";
    const { stroke, strokeWidth } = editor.shapeStyle;
    if (!canvas || !pen) return;
    const brush = canvas.freeDrawingBrush instanceof PencilBrush ? canvas.freeDrawingBrush : new PencilBrush(canvas);
    brush.color = stroke;
    brush.width = strokeWidth;
    brush.strokeLineCap = "round";
    brush.strokeLineJoin = "round";
    // Points closer than this (in screen pixels) are dropped: smoother, lighter strokes.
    brush.decimate = 1;
    canvas.freeDrawingBrush = brush;
  });

  // Undo, redo and other external changes flow from the editor state into Fabric.
  $effect(() => {
    void canvasGeneration;
    const data = editor.annotations[page.id];
    if (!canvas) return;
    untrack(() => {
      if (data !== lastSynced) void loadAnnotations(data);
    });
  });

  function createCanvas(element: HTMLCanvasElement): Canvas {
    const instance = new Canvas(element, {
      width,
      height,
      preserveObjectStacking: true,
      selection: editor.tool === "select",
      targetFindTolerance: 6,
      // Lets touch users scroll the document unless an object is selected.
      allowTouchScrolling: true,
    });
    instance.setZoom(editor.zoom);
    canvas = instance;
    setTouchScrolling(true);

    instance.on("object:modified", ({ target }) => {
      if (bakeScale(target)) instance.requestRenderAll();
      transforming.clear();
      scheduleSave();
      reportSelection();
      refreshPreview();
    });
    instance.on("object:removed", () => {
      scheduleSave();
      refreshPreview();
    });
    const startTransform = ({ target }: { target: FabricObject }) => {
      const moving = target instanceof ActiveSelection ? target.getObjects() : [target];
      for (const object of moving) {
        if (!isNative(object) || transforming.has(object)) continue;
        transforming.add(object);
        object.ytaGhost = false;
        object.dirty = true;
      }
    };
    instance.on("object:moving", startTransform);
    instance.on("object:scaling", startTransform);
    instance.on("object:rotating", startTransform);
    instance.on("object:resizing", startTransform);
    instance.on("path:created", ({ path }) => {
      // A freehand stroke from the pen: kept as a vector path, like signatures.
      markInk(path);
      scheduleSave();
    });
    instance.on("text:changed", ({ target }) => {
      scheduleSave(500, `typing:${page.id}`);
      // Arabic, Chinese, Japanese or Korean typed for the first time: measure
      // again once their font has arrived.
      if (target instanceof IText) {
        void ensureScriptFontsFor(target.text).then((loaded) => {
          if (!loaded) return;
          target.initDimensions();
          target.setCoords();
          instance.requestRenderAll();
        });
      }
    });
    instance.on("text:editing:entered", ({ target }) => {
      if (isNative(target) && target.ytaGhost) {
        target.ytaGhost = false;
        target.dirty = true;
        instance.requestRenderAll();
      }
    });
    instance.on("text:editing:exited", ({ target }) => {
      if (isText(target) && target.text.trim() === "") {
        if (isNative(target)) {
          // Emptied document text: the original stays erased.
          markDeleted(target);
          instance.discardActiveObject();
        } else {
          instance.remove(target);
        }
      }
      scheduleSave();
      refreshPreview();
    });
    instance.on("selection:created", () => {
      setTouchScrolling(false);
      syncSelectionLock(instance);
      reportSelection();
      refreshPreview();
    });
    instance.on("selection:updated", () => {
      syncSelectionLock(instance);
      reportSelection();
      refreshPreview();
    });
    instance.on("selection:cleared", () => {
      setTouchScrolling(true);
      editor.reportSelection(page.id, null);
      refreshPreview();
    });
    instance.on("mouse:out", () => {
      if (editor.tool === "edit") clearHover();
    });
    instance.on("before:render", ({ ctx }) => {
      if (masks.length === 0) return;
      const vpt = instance.viewportTransform;
      ctx.save();
      ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
      for (const mask of masks) {
        ctx.fillStyle = mask.color;
        ctx.beginPath();
        mask.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });
    // Fabric places the hidden textarea used for typing from a cached offset,
    // which goes stale as the workspace scrolls.
    instance.on("mouse:down:before", () => instance.calcOffset());
    instance.on("mouse:down", onPointerDown);
    instance.on("mouse:move", onPointerMove);
    instance.on("mouse:up", onPointerUp);

    cleanups = [
      editor.registerPage(page.id, controller),
      editor.registerFlusher(flushSave),
      installAlignmentGuides(instance, () => ({ width: page.width, height: page.height })),
    ];
    lastSynced = undefined;
    canvasGeneration += 1;
    return instance;
  }

  function destroyCanvas(instance: Canvas) {
    // Ending the edit removes Fabric's hidden textarea and keeps the typed text.
    const active = instance.getActiveObject();
    if (active instanceof IText && active.isEditing) active.exitEditing();
    flushSave();
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    loadAbort?.abort();
    loadAbort = null;
    loading = false;
    canvas = null;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    transforming.clear();
    hovered = null;
    instance.dispose().catch(() => {});
  }

  function setTouchScrolling(enabled: boolean) {
    // While something is selected, touch gestures move it instead of scrolling.
    if (canvas) canvas.upperCanvasEl.style.touchAction = enabled ? "pan-x pan-y" : "none";
  }

  async function loadAnnotations(data: PageAnnotations | undefined) {
    const instance = canvas;
    if (!instance) return;
    lastSynced = data;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;

    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
    loading = true;
    try {
      instance.discardActiveObject();
      if (data) {
        // Embedded fonts must be ready before Fabric measures any text.
        await ensureFontsFor(data.objects);
        if (abort.signal.aborted) return;
        await instance.loadFromJSON(data, undefined, { signal: abort.signal });
        instance.getObjects().forEach(prepareObject);
      } else {
        instance.remove(...instance.getObjects());
      }
      instance.requestRenderAll();
      refreshPreview(0);
    } catch (error) {
      if (!abort.signal.aborted) console.error("Error al cargar las anotaciones:", error);
    } finally {
      if (loadAbort === abort) {
        loadAbort = null;
        loading = false;
      }
    }
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  /** Edits are written to the editor state (and undo history) after `delay`. */
  function scheduleSave(delay = 0, coalesceKey?: string) {
    if (loading || !canvas) return;
    saveKey = coalesceKey;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, delay);
  }

  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!canvas) return;
    const { version, objects } = canvas.toObject() as PageAnnotations;
    lastSynced = editor.setPageAnnotations(
      page.id,
      objects.length > 0 ? { version, objects } : null,
      saveKey,
    );
  }

  function reportSelection() {
    if (canvas) editor.reportSelection(page.id, describeSelection(canvas));
  }

  /** Adds a new object, selects it and records the change. */
  function place(object: FabricObject, at: { x: number; y: number }) {
    if (!canvas) return;
    object.set({ left: at.x, top: at.y });
    object.setCoords();
    canvas.add(object);
    canvas.setActiveObject(object);
    canvas.requestRenderAll();
    scheduleSave();
    reportSelection();
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  function onPointerDown({ target, e }: TPointerEventInfo) {
    pendingTextAt = null;
    drawStart = null;
    if (!canvas) return;
    const tool = editor.tool;
    if (tool === "crop") {
      const point = clampToPage(canvas.getScenePoint(e));
      cropStart = point;
      cropDraft = { x: point.x, y: point.y, width: 0, height: 0 };
      if (editor.pendingCrop?.pageId !== page.id) editor.pendingCrop = null;
    } else if (tool === "text" && !target) pendingTextAt = canvas.getScenePoint(e);
    else if (isDrawTool(tool)) drawStart = canvas.getScenePoint(e);
    else if (tool === "edit" && !target) {
      const scene = canvas.getScenePoint(e);
      const point: Point = [scene.x, scene.y];
      const lineOnly = (e as MouseEvent).altKey === true;
      if (analysis) editTextAt(point, lineOnly, e);
      else pendingEdit = { point, lineOnly };
    }
  }

  /** With Shift, boxes become squares and lines snap to 45°. */
  function constrain(tool: DrawTool, start: { x: number; y: number }, point: { x: number; y: number }, shift: boolean) {
    if (!shift) return point;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (tool === "line" || tool === "arrow") {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
    }
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
  }

  function clampToPage(point: { x: number; y: number }) {
    return { x: Math.max(0, Math.min(page.width, point.x)), y: Math.max(0, Math.min(page.height, point.y)) };
  }

  function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }

  function onPointerMove({ e, target }: TPointerEventInfo) {
    const tool = editor.tool;
    if (tool === "crop" && cropStart && canvas) {
      cropDraft = rectBetween(cropStart, clampToPage(canvas.getScenePoint(e)));
      return;
    }
    if (tool === "edit" && canvas && analysis) {
      const point = canvas.getScenePoint(e);
      showHover(target ? null : unitAt([point.x, point.y], (e as MouseEvent).altKey === true));
      return;
    }
    if (!drawStart || !canvas || !isDrawTool(tool)) return;
    const end = constrain(tool, drawStart, canvas.getScenePoint(e), e.shiftKey);
    drawShapePreview(canvas, tool, drawStart, end, editor.shapeStyle, editor.highlightColor);
  }

  function onPointerUp({ e }: TPointerEventInfo) {
    if (!canvas) return;
    const tool = editor.tool;

    if (tool === "crop" && cropStart) {
      const rect = rectBetween(cropStart, clampToPage(canvas.getScenePoint(e)));
      cropStart = null;
      cropDraft = null;
      // A click instead of a drag keeps the previous area.
      if (rect.width > 8 / editor.zoom && rect.height > 8 / editor.zoom) editor.pendingCrop = { pageId: page.id, rect };
      return;
    }

    if (drawStart && isDrawTool(tool)) {
      const start = drawStart;
      drawStart = null;
      clearTopLayer(canvas);
      let end = constrain(tool, start, canvas.getScenePoint(e), e.shiftKey);
      // A click (no drag) creates a shape of a default size at that spot.
      if (Math.hypot(end.x - start.x, end.y - start.y) < 4 / editor.zoom) {
        const size = DEFAULT_SIZES[tool];
        end = { x: start.x + size.width / 2, y: start.y + size.height / 2 };
        if (tool === "line" || tool === "arrow") {
          start.x -= size.width / 2;
        } else {
          start.x -= size.width / 2;
          start.y -= size.height / 2;
        }
      }
      const shape = prepareObject(createShape(tool, start, end, editor.shapeStyle, editor.highlightColor));
      canvas.add(shape);
      canvas.setActiveObject(shape);
      editor.tool = "select";
      if (tool === "note" && shape instanceof IText) {
        shape.enterEditing();
        shape.selectAll();
      }
      canvas.requestRenderAll();
      scheduleSave();
      reportSelection();
      return;
    }

    const textStart = pendingTextAt;
    pendingTextAt = null;
    if (!textStart || tool !== "text") return;
    // A drag is not a click: only place text where the pointer was released close by.
    const end = canvas.getScenePoint(e);
    if (Math.hypot(end.x - textStart.x, end.y - textStart.y) > 8 / editor.zoom) return;

    const text = createText("Texto", editor.textStyle);
    text.set({ left: textStart.x + text.width / 2, top: textStart.y });
    text.setCoords();
    canvas.add(text);
    canvas.setActiveObject(text);
    text.enterEditing();
    text.selectAll();
    editor.tool = "select";
    canvas.requestRenderAll();
    scheduleSave();
  }

  /** Centre of the part of the page currently on screen, in scene units. */
  function visibleCenter(): { x: number; y: number } {
    const rect = container.getBoundingClientRect();
    const viewport = container.closest(".workspace")?.getBoundingClientRect() ?? rect;
    const top = Math.max(rect.top, viewport.top);
    const bottom = Math.min(rect.bottom, viewport.bottom);
    const left = Math.max(rect.left, viewport.left);
    const right = Math.min(rect.right, viewport.right);
    if (bottom <= top || right <= left) return { x: page.width / 2, y: page.height / 2 };
    return {
      x: ((left + right) / 2 - rect.left) / editor.zoom,
      y: ((top + bottom) / 2 - rect.top) / editor.zoom,
    };
  }

  async function placeImage(url: string, at?: { x: number; y: number }, width?: number) {
    if (!canvas) return;
    const image = await createImage(url, width ?? page.width * 0.6, width ? Infinity : page.height * 0.6);
    if (!canvas) return;
    if (width) image.scaleToWidth(width);
    place(image, at ?? visibleCenter());
  }

  function hasImageFiles(event: DragEvent) {
    return [...(event.dataTransfer?.items ?? [])].some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
  }

  function ondragover(event: DragEvent) {
    if (!canvas || !hasImageFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  async function ondrop(event: DragEvent) {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!canvas || files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvas.getScenePoint(event);
    for (const [offset, file] of files.entries()) {
      try {
        const url = await importImage(file);
        await placeImage(url, { x: point.x + offset * 16, y: point.y + offset * 16 });
      } catch (error) {
        console.error("Error al importar la imagen:", error);
        notifications.error(t("No se pudo usar «{name}» como imagen.", { name: file.name }));
      }
    }
  }

  /** Runs an edit on the selection unless something in it is locked. */
  function editSelection(edit: (canvas: Canvas, active: FabricObject) => void, delay = 0, key?: string) {
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    if (selectedObjects(canvas).some(isLocked)) {
      notifications.info(t("La selección incluye objetos bloqueados. Desbloquéalos para modificarlos."));
      return;
    }
    edit(canvas, active);
    canvas.requestRenderAll();
    scheduleSave(delay, key);
    reportSelection();
  }

  const controller: PageController = {
    addImage: (url, options) => placeImage(url, undefined, options?.width),

    addSignature(signature) {
      if (!canvas) return;
      place(createSignature(signature, placedSignatureWidth(page.width, signature)), visibleCenter());
    },

    addMark(kind) {
      if (!canvas) return;
      place(createMark(kind, 20, "#111111"), visibleCenter());
    },

    addText(content, style) {
      if (!canvas) return;
      place(createText(content, { ...editor.textStyle, ...style }), visibleCenter());
    },

    applyTextStyle(style) {
      if (canvas && applyTextStyle(canvas, style)) {
        scheduleSave(150, `style:${page.id}`);
        reportSelection();
      }
    },

    setLinkTarget(target) {
      if (canvas && setLinkTarget(canvas, target)) {
        scheduleSave(0);
        reportSelection();
      }
    },

    applyShapeStyle(style, highlight) {
      if (canvas && applyShapeStyle(canvas, style, highlight)) {
        scheduleSave(150, `shape:${page.id}`);
        reportSelection();
      }
    },

    rotateSelection(degrees) {
      editSelection((_, active) => {
        active.rotate((((active.angle || 0) + degrees) % 360 + 360) % 360);
        active.setCoords();
      });
    },

    flipSelection(axis) {
      editSelection((_, active) => {
        if (axis === "x") active.set("flipX", !active.flipX);
        else active.set("flipY", !active.flipY);
      });
    },

    setSelectionOpacity(opacity) {
      editSelection((instance) => {
        for (const object of selectedObjects(instance)) object.set("opacity", opacity);
      }, 150, `opacity:${page.id}`);
    },

    arrangeSelection(action) {
      if (!canvas || selectedObjects(canvas).length === 0) return;
      if (arrange(canvas, action)) scheduleSave();
      reportSelection();
    },

    alignSelection(mode) {
      editSelection((instance) => alignObjects(instance, mode, page));
    },

    distributeSelection(axis) {
      editSelection((instance) => distributeObjects(instance, axis));
    },

    groupSelection() {
      if (canvas && groupSelected(canvas)) {
        scheduleSave();
        reportSelection();
      }
    },

    ungroupSelection() {
      if (canvas && ungroupSelected(canvas).length > 0) {
        scheduleSave();
        reportSelection();
      }
    },

    setSelectionBounds(change, keepRatio) {
      editSelection((instance) => setObjectBounds(instance, change, keepRatio), 250, `bounds:${page.id}`);
    },

    markText(range, kind) {
      if (!canvas || textDivs.length === 0 || !range.intersectsNode(textLayerElement as Node)) return 0;
      const { lines, rotation } = selectedLines(range);
      if (lines.length === 0) return 0;
      const created = lines.map((line) => {
        if (kind === "highlight") {
          const pad = Math.min(line.width, line.height) * 0.06;
          return prepareObject(
            createShape(
              "highlight",
              { x: line.x - pad, y: line.y - pad },
              { x: line.x + line.width + pad, y: line.y + line.height + pad },
              editor.shapeStyle,
              editor.highlightColor,
            ),
          );
        }
        const { from, to, width: strokeWidth } = markLine(kind, line, rotation);
        return prepareObject(
          createShape("line", { x: from[0], y: from[1] }, { x: to[0], y: to[1] }, { ...editor.shapeStyle, strokeWidth }, editor.highlightColor),
        );
      });
      editor.tool = "select";
      for (const object of created) canvas.add(object);
      canvas.discardActiveObject();
      canvas.setActiveObject(created.length === 1 ? created[0] : new ActiveSelection(created, { canvas }));
      canvas.requestRenderAll();
      scheduleSave();
      reportSelection();
      return created.length;
    },

    toggleLockSelection() {
      if (!canvas) return;
      const objects = selectedObjects(canvas);
      if (objects.length === 0) return;
      const lock = !objects.every(isLocked);
      for (const object of objects) setLocked(object, lock);
      syncSelectionLock(canvas);
      canvas.requestRenderAll();
      scheduleSave();
      reportSelection();
    },

    deleteSelection() {
      if (!canvas) return { removed: 0, locked: 0 };
      const objects = selectedObjects(canvas);
      const removable = editableSelection(canvas);
      if (removable.length > 0) {
        canvas.discardActiveObject();
        removeObjects(canvas, removable);
        scheduleSave();
        refreshPreview();
      }
      return { removed: removable.length, locked: objects.length - removable.length };
    },

    restoreOriginalText() {
      if (!canvas) return;
      const edits = selectedObjects(canvas).filter(isNative);
      if (edits.length === 0) return;
      canvas.discardActiveObject();
      canvas.remove(...edits);
      canvas.requestRenderAll();
      scheduleSave();
      refreshPreview(0);
    },

    async duplicateSelection() {
      if (!canvas) return;
      const data = serializeSelection(canvas);
      if (data.length === 0) return;
      await pasteObjects(canvas, data, 14);
      scheduleSave();
      reportSelection();
    },

    copySelection() {
      if (!canvas) return null;
      const objects = serializeSelection(canvas);
      return objects.length > 0 ? { objects, text: selectionText(canvas) } : null;
    },

    async pasteObjects(objects, offset) {
      if (!canvas) return;
      const pasted = await pasteObjects(canvas, objects, offset);
      pasted.forEach(prepareObject);
      scheduleSave();
      reportSelection();
    },

    nudgeSelection(dx, dy) {
      editSelection((_, active) => {
        active.set({ left: active.left + dx, top: active.top + dy });
        active.setCoords();
      }, 300, `nudge:${page.id}`);
    },

    clearSelection() {
      if (!canvas) return;
      const active = canvas.getActiveObject();
      if (active instanceof IText && active.isEditing) active.exitEditing();
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    },

    isEditingText() {
      const active = canvas?.getActiveObject();
      return active instanceof IText && active.isEditing;
    },
  };
</script>

<div
  class="page text-scale"
  class:selecting-text={editor.tool === "textselect"}
  bind:this={container}
  style:width="{width}px"
  style:height="{height}px"
  style:--scale-factor={editor.zoom}
  style:--user-unit={pdfPage?.userUnit ?? 1}
  role="group"
  aria-label={t("Página {n}", { n: index + 1 })}
  {ondragover}
  {ondrop}
>
  {#if active}
    <canvas class="pdf-layer" bind:this={pdfCanvas} style:width="{width}px" style:height="{height}px"></canvas>
    <canvas class="decoration-layer" bind:this={decorationCanvas} style:width="{width}px" style:height="{height}px"></canvas>
    {#if highlights.length > 0}
      <div class="search-layer" aria-hidden="true">
        {#each highlights as box, i (i)}
          <span
            class="search-hit"
            class:active={box.active}
            style:left="{box.left * editor.zoom}px"
            style:top="{box.top * editor.zoom}px"
            style:width="{box.width * editor.zoom}px"
            style:height="{box.height * editor.zoom}px"
          ></span>
        {/each}
      </div>
    {/if}
    <div class="textLayer" bind:this={textLayerElement}></div>
    <div class="annotation-layer">
      <canvas bind:this={fabricElement}></canvas>
    </div>
    {#if pdfPage && editor.tool === "select"}
      <FormLayer {page} {pdfPage} zoom={editor.zoom} />
    {/if}
    {#if cropArea}
      <svg class="crop-layer" viewBox="0 0 {page.width} {page.height}" preserveAspectRatio="none" aria-hidden="true">
        <path
          class="crop-shade"
          fill-rule="evenodd"
          d="M0 0H{page.width}V{page.height}H0Z M{cropArea.x} {cropArea.y}h{cropArea.width}v{cropArea.height}h{-cropArea.width}Z"
        />
        <rect
          class="crop-frame"
          x={cropArea.x}
          y={cropArea.y}
          width={cropArea.width}
          height={cropArea.height}
          vector-effect="non-scaling-stroke"
        />
      </svg>
    {/if}
  {/if}
  {#if !rendered}
    <div class="placeholder" aria-hidden="true">
      <span class="spinner"></span>
    </div>
  {/if}
  {#if active && editor.tool === "edit" && analysisState === "loading"}
    <div class="text-status" role="status">{t("Leyendo el texto de la página…")}</div>
  {/if}
</div>

<style>
  .page {
    position: relative;
    background: var(--color-paper);
    box-shadow:
      0 1px 3px rgba(16, 24, 40, 0.12),
      0 8px 28px rgba(16, 24, 40, 0.08);
  }
  .pdf-layer,
  .decoration-layer {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }
  /* The document's text is transparent and only takes the pointer with the text tool. */
  .textLayer {
    z-index: 1;
    pointer-events: none;
  }
  .selecting-text .textLayer {
    z-index: 3;
    pointer-events: auto;
  }
  .annotation-layer {
    position: absolute;
    inset: 0;
    z-index: 2;
  }
  .selecting-text .annotation-layer {
    pointer-events: none;
  }
  .search-layer {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
  }
  .search-hit {
    position: absolute;
    border-radius: 2px;
    background: rgba(255, 196, 0, 0.4);
    mix-blend-mode: multiply;
  }
  .search-hit.active {
    background: rgba(255, 120, 0, 0.55);
    outline: 2px solid rgba(230, 100, 0, 0.9);
  }
  .crop-layer {
    position: absolute;
    inset: 0;
    z-index: 4;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .crop-shade {
    fill: rgba(15, 23, 42, 0.45);
  }
  .crop-frame {
    fill: none;
    stroke: #ffffff;
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }
  .annotation-layer :global(.canvas-container) {
    margin: 0 !important;
  }
  .text-status {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(16, 24, 40, 0.78);
    color: white;
    font-size: 12px;
    pointer-events: none;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #b5bcc7;
    background: var(--color-paper);
    pointer-events: none;
  }
</style>
