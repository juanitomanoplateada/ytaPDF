<script lang="ts">
  import { untrack } from "svelte";
  import { Canvas, IText, type FabricObject, type TPointerEventInfo } from "fabric";
  import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
  import {
    applyShapeStyle,
    applyTextStyle,
    arrange,
    bakeScale,
    clearTopLayer,
    createImage,
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
    pasteObjects,
    prepareObject,
    selectedObjects,
    selectionText,
    serializeSelection,
    setLocked,
    syncSelectionLock,
  } from "../fabricSetup";
  import {
    editor,
    type DrawTool,
    type PageAnnotations,
    type PageController,
    type PageRef,
  } from "../editor.svelte";
  import { ensureFontsFor } from "../embeddedFonts";
  import { importImage } from "../images";
  import { notifications } from "../notifications.svelte";
  import { isRenderCancelled, renderPage } from "../pdfjs";
  import FormLayer from "./FormLayer.svelte";

  interface Props {
    page: PageRef;
    index: number;
    /** Whether the page is close enough to the viewport to be rendered. */
    active: boolean;
  }

  let { page, index, active }: Props = $props();

  const DRAW_TOOLS: DrawTool[] = ["rect", "ellipse", "line", "arrow", "highlight", "redact"];
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
  let cleanups: Array<() => void> = [];

  const width = $derived(page.width * editor.zoom);
  const height = $derived(page.height * editor.zoom);

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
    // Form values reach PDF.js asynchronously; repaint when they arrive.
    void editor.formRevision[page.sourceId];
    if (!target || !proxy) return;

    let cancelled = false;
    // Render off-screen and swap, so zooming stretches the old bitmap instead
    // of flashing an empty page.
    const buffer = document.createElement("canvas");
    const task: RenderTask = renderPage(proxy, buffer, zoom, undefined, rotation);
    task.promise
      .then(() => {
        if (cancelled) return;
        target.width = buffer.width;
        target.height = buffer.height;
        target.getContext("2d")?.drawImage(buffer, 0, 0);
        rendered = true;
      })
      .catch((error) => {
        if (!isRenderCancelled(error)) console.error("Error al dibujar la página:", error);
      });

    return () => {
      cancelled = true;
      task.cancel();
    };
  });

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
    const drawing = isDrawTool(tool);
    canvas.selection = tool === "select";
    // While drawing, clicks over existing objects start a new shape.
    canvas.skipTargetFind = drawing;
    canvas.defaultCursor = tool === "text" ? "text" : drawing ? "crosshair" : "default";
    if (tool !== "select") canvas.discardActiveObject();
    canvas.requestRenderAll();
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
      scheduleSave();
      reportSelection();
    });
    instance.on("object:removed", () => scheduleSave());
    instance.on("text:changed", () => scheduleSave(500, `typing:${page.id}`));
    instance.on("text:editing:exited", ({ target }) => {
      if (isText(target) && target.text.trim() === "") instance.remove(target);
      scheduleSave();
    });
    instance.on("selection:created", () => {
      setTouchScrolling(false);
      syncSelectionLock(instance);
      reportSelection();
    });
    instance.on("selection:updated", () => {
      syncSelectionLock(instance);
      reportSelection();
    });
    instance.on("selection:cleared", () => {
      setTouchScrolling(true);
      editor.reportSelection(page.id, null);
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
    instance.dispose().catch(() => {});
  }

  function setTouchScrolling(enabled: boolean) {
    // While something is selected, touch gestures move it instead of scrolling.
    if (canvas) canvas.upperCanvasEl.style.touchAction = enabled ? "pan-x pan-y pinch-zoom" : "none";
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
    if (tool === "text" && !target) pendingTextAt = canvas.getScenePoint(e);
    else if (isDrawTool(tool)) drawStart = canvas.getScenePoint(e);
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

  function onPointerMove({ e }: TPointerEventInfo) {
    const tool = editor.tool;
    if (!drawStart || !canvas || !isDrawTool(tool)) return;
    const end = constrain(tool, drawStart, canvas.getScenePoint(e), e.shiftKey);
    drawShapePreview(canvas, tool, drawStart, end, editor.shapeStyle, editor.highlightColor);
  }

  function onPointerUp({ e }: TPointerEventInfo) {
    if (!canvas) return;
    const tool = editor.tool;

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

  async function placeImage(url: string, at?: { x: number; y: number }) {
    if (!canvas) return;
    const image = await createImage(url, page.width * 0.6, page.height * 0.6);
    if (!canvas) return;
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
        notifications.error(`No se pudo usar «${file.name}» como imagen.`);
      }
    }
  }

  /** Runs an edit on the selection unless something in it is locked. */
  function editSelection(edit: (canvas: Canvas, active: FabricObject) => void, delay = 0, key?: string) {
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    if (selectedObjects(canvas).some(isLocked)) {
      notifications.info("La selección incluye objetos bloqueados. Desbloquéalos para modificarlos.");
      return;
    }
    edit(canvas, active);
    canvas.requestRenderAll();
    scheduleSave(delay, key);
    reportSelection();
  }

  const controller: PageController = {
    addImage: (url) => placeImage(url),

    addSignature(signature) {
      if (!canvas) return;
      place(createSignature(signature, Math.min(220, page.width * 0.4)), visibleCenter());
    },

    addText(content) {
      if (!canvas) return;
      place(createText(content, editor.textStyle), visibleCenter());
    },

    applyTextStyle(style) {
      if (canvas && applyTextStyle(canvas, style)) {
        scheduleSave(150, `style:${page.id}`);
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
        canvas.remove(...removable);
        canvas.requestRenderAll();
      }
      return { removed: removable.length, locked: objects.length - removable.length };
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
  class="page"
  bind:this={container}
  style:width="{width}px"
  style:height="{height}px"
  role="group"
  aria-label="Página {index + 1}"
  {ondragover}
  {ondrop}
>
  {#if active}
    <canvas class="pdf-layer" bind:this={pdfCanvas} style:width="{width}px" style:height="{height}px"></canvas>
    <div class="annotation-layer">
      <canvas bind:this={fabricElement}></canvas>
    </div>
    {#if pdfPage && editor.tool === "select"}
      <FormLayer {page} {pdfPage} zoom={editor.zoom} />
    {/if}
  {/if}
  {#if !rendered}
    <div class="placeholder" aria-hidden="true">
      <span class="spinner"></span>
    </div>
  {/if}
</div>

<style>
  .page {
    position: relative;
    background: white;
    box-shadow:
      0 1px 3px rgba(16, 24, 40, 0.12),
      0 8px 28px rgba(16, 24, 40, 0.08);
  }
  .pdf-layer {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }
  .annotation-layer {
    position: absolute;
    inset: 0;
  }
  .annotation-layer :global(.canvas-container) {
    margin: 0 !important;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #b5bcc7;
    background: white;
    pointer-events: none;
  }
</style>
