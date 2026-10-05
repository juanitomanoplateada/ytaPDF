<script lang="ts">
  import { untrack } from "svelte";
  import { Canvas, IText, type TPointerEventInfo } from "fabric";
  import type { RenderTask } from "pdfjs-dist";
  import {
    applyTextStyle,
    bakeTextScale,
    createImage,
    createText,
    describeSelection,
    isText,
    selectedObjects,
  } from "../fabricSetup";
  import { editor, type PageAnnotations, type PageController, type PageRef } from "../editor.svelte";
  import { importImage } from "../images";
  import { notifications } from "../notifications.svelte";
  import { isRenderCancelled, renderPage } from "../pdfjs";

  interface Props {
    page: PageRef;
    index: number;
    /** Whether the page is close enough to the viewport to be rendered. */
    active: boolean;
  }

  let { page, index, active }: Props = $props();

  let container: HTMLDivElement;
  let pdfCanvas = $state<HTMLCanvasElement>();
  let fabricElement = $state<HTMLCanvasElement>();
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
  let cleanups: Array<() => void> = [];

  const width = $derived(page.width * editor.zoom);
  const height = $derived(page.height * editor.zoom);

  // ── PDF layer ─────────────────────────────────────────────────────────────

  $effect(() => {
    if (!active) rendered = false;
  });

  $effect(() => {
    const target = pdfCanvas;
    const zoom = editor.zoom;
    const source = editor.sources.get(page.sourceId);
    if (!target || !source) return;

    let cancelled = false;
    let task: RenderTask | null = null;
    // Render off-screen and swap, so zooming stretches the old bitmap instead
    // of flashing an empty page.
    const buffer = document.createElement("canvas");
    source.pdf
      .getPage(page.sourceIndex + 1)
      .then(async (pdfPage) => {
        if (cancelled) return;
        task = renderPage(pdfPage, buffer, zoom);
        await task.promise;
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
      task?.cancel();
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
    canvas.selection = tool === "select";
    canvas.defaultCursor = tool === "text" ? "text" : "default";
    if (tool === "text") canvas.discardActiveObject();
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
      if (bakeTextScale(target)) instance.requestRenderAll();
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
      reportSelection();
    });
    instance.on("selection:updated", reportSelection);
    instance.on("selection:cleared", () => {
      setTouchScrolling(true);
      editor.reportSelection(page.id, null);
    });
    // Fabric places the hidden textarea used for typing from a cached offset,
    // which goes stale as the workspace scrolls.
    instance.on("mouse:down:before", () => instance.calcOffset());
    instance.on("mouse:down", onPointerDown);
    instance.on("mouse:up", onPointerUp);

    cleanups = [editor.registerPage(page.id, controller), editor.registerFlusher(flushSave)];
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
        await instance.loadFromJSON(data, undefined, { signal: abort.signal });
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

  // ── Interaction ───────────────────────────────────────────────────────────

  function onPointerDown({ target, e }: TPointerEventInfo) {
    pendingTextAt = null;
    if (editor.tool !== "text" || target || !canvas) return;
    pendingTextAt = canvas.getScenePoint(e);
  }

  function onPointerUp({ e }: TPointerEventInfo) {
    const start = pendingTextAt;
    pendingTextAt = null;
    if (!start || !canvas || editor.tool !== "text") return;
    // A drag is not a click: only place text where the pointer was released close by.
    const end = canvas.getScenePoint(e);
    if (Math.hypot(end.x - start.x, end.y - start.y) > 8 / editor.zoom) return;

    const text = createText("Texto", editor.textStyle);
    text.set({ left: start.x + text.width / 2, top: start.y });
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
    const point = at ?? visibleCenter();
    image.set({ left: point.x, top: point.y });
    image.setCoords();
    canvas.add(image);
    canvas.setActiveObject(image);
    canvas.requestRenderAll();
    scheduleSave();
    reportSelection();
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

  const controller: PageController = {
    addImage: (url) => placeImage(url),

    applyTextStyle(style) {
      if (canvas && applyTextStyle(canvas, style)) {
        scheduleSave(150, `style:${page.id}`);
        reportSelection();
      }
    },

    rotateSelection(degrees) {
      const active = canvas?.getActiveObject();
      if (!canvas || !active) return;
      active.rotate((((active.angle || 0) + degrees) % 360 + 360) % 360);
      active.setCoords();
      canvas.requestRenderAll();
      scheduleSave();
      reportSelection();
    },

    flipSelection(axis) {
      const active = canvas?.getActiveObject();
      if (!canvas || !active) return;
      if (axis === "x") active.set("flipX", !active.flipX);
      else active.set("flipY", !active.flipY);
      canvas.requestRenderAll();
      scheduleSave();
      reportSelection();
    },

    setSelectionOpacity(opacity) {
      if (!canvas) return;
      for (const object of selectedObjects(canvas)) object.set("opacity", opacity);
      canvas.requestRenderAll();
      scheduleSave(150, `opacity:${page.id}`);
      reportSelection();
    },

    deleteSelection() {
      if (!canvas) return;
      const objects = selectedObjects(canvas);
      if (objects.length === 0) return;
      canvas.discardActiveObject();
      canvas.remove(...objects);
      canvas.requestRenderAll();
    },

    nudgeSelection(dx, dy) {
      const active = canvas?.getActiveObject();
      if (!canvas || !active) return;
      active.set({ left: active.left + dx, top: active.top + dy });
      active.setCoords();
      canvas.requestRenderAll();
      scheduleSave(300, `nudge:${page.id}`);
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
