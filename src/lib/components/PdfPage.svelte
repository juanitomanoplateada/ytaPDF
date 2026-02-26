<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { editorStore } from "../store";
  import * as fabric from "fabric";
  import type { PDFPageProxy } from "pdfjs-dist";

  const deleteIcon =
    "data:image/svg+xml,%3C%3Fxml version='1.0' encoding='utf-8'%3F%3E%3Csvg version='1.1' id='Layer_1' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' x='0px' y='0px' viewBox='0 0 512 512' style='enable-background:new 0 0 512 512;' xml:space='preserve'%3E%3Cpath fill='%23FF0000' d='M256,0C114.615,0,0,114.615,0,256s114.615,256,256,256s256-114.615,256-256S397.385,0,256,0z M341.333,311.168 L311.168,341.333L256,286.165L200.832,341.333l-30.165-30.165L225.835,256l-55.168-55.168l30.165-30.165L256,225.835l55.168-55.168 l30.165,30.165L286.165,256L341.333,311.168z'/%3E%3C/svg%3E";

  const deleteImg = document.createElement("img");
  deleteImg.src = deleteIcon;

  const deleteControl = new fabric.Control({
    x: 0.5,
    y: -0.5,
    offsetY: -8,
    offsetX: 8,
    cursorStyle: "pointer",

    mouseUpHandler: function (eventData: any, transform: any) {
      const target = transform.target;
      const canvas = target.canvas;
      if (canvas) {
        canvas.remove(target);
        canvas.requestRenderAll();
        canvas.fire("object:removed", { target });
      }
      return true;
    },

    render: function (
      ctx: any,
      left: any,
      top: any,
      styleOverride: any,
      fabricObject: any,
    ) {
      const size = (this as any).cornerSize || 24;
      ctx.save();
      ctx.translate(left, top);
      ctx.rotate(fabric.util.degreesToRadians(fabricObject.angle || 0));
      ctx.drawImage(deleteImg, -size / 2, -size / 2, size, size);
      ctx.restore();
    },

    // @ts-ignore
    cornerSize: 24,
  } as any);

  // Initialize controls properly for Fabric.js v7
  const defaultControls = (fabric as any).controlsUtils
    ?.createObjectDefaultControls
    ? (fabric as any).controlsUtils.createObjectDefaultControls()
    : {};

  (fabric.Object as any).ownDefaults = {
    ...(fabric.Object as any).ownDefaults,
    controls: {
      ...defaultControls,
      deleteControl,
    },
  };

  export let pageProxy: PDFPageProxy;
  export let pageNumber: number;

  let baseCanvas: HTMLCanvasElement;
  let interactiveCanvas: HTMLCanvasElement;
  let fabricApp: fabric.Canvas;
  let renderTask: any = null;

  let lastRenderedZoom = 0;
  let lastRenderedProxy: any = null;

  $: if (pageProxy && baseCanvas && $editorStore.globalZoom) {
    if (
      lastRenderedZoom !== $editorStore.globalZoom ||
      lastRenderedProxy !== pageProxy
    ) {
      lastRenderedZoom = $editorStore.globalZoom;
      lastRenderedProxy = pageProxy;
      triggerRender($editorStore.globalZoom);
    }
  }

  function triggerRender(zoom: number) {
    renderPageLayers(zoom).catch((err) => {
      if (err.name !== "RenderingCancelledException") {
        console.error("PDF Render Error:", err);
      }
    });
  }

  let lastActiveTool = "";
  $: if (fabricApp && $editorStore.activeTool !== lastActiveTool) {
    lastActiveTool = $editorStore.activeTool;
    if ($editorStore.activeTool === "TEXT") {
      fabricApp.defaultCursor = "text";
      fabricApp.discardActiveObject();
      fabricApp.requestRenderAll();
    } else {
      fabricApp.defaultCursor = "default";
    }
  }

  async function renderPageLayers(currentZoom: number) {
    const pixelRatio = window.devicePixelRatio || 1;
    const viewport = pageProxy.getViewport({ scale: currentZoom });
    const scaledViewport = pageProxy.getViewport({
      scale: currentZoom * pixelRatio,
    });

    const CSS_w = viewport.width;
    const CSS_h = viewport.height;

    if (
      baseCanvas.width !== scaledViewport.width ||
      baseCanvas.height !== scaledViewport.height
    ) {
      baseCanvas.width = scaledViewport.width;
      baseCanvas.height = scaledViewport.height;
      baseCanvas.style.width = `${CSS_w}px`;
      baseCanvas.style.height = `${CSS_h}px`;
    }

    const ctx = baseCanvas.getContext("2d");
    if (ctx) {
      if (renderTask) {
        renderTask.cancel();
      }

      renderTask = pageProxy.render({
        canvasContext: ctx,
        viewport: scaledViewport,
      } as any);
      await renderTask.promise;
      renderTask = null;
    }

    if (!fabricApp) {
      fabricApp = new fabric.Canvas(interactiveCanvas, {
        width: CSS_w,
        height: CSS_h,
        selection: true,
        preserveObjectStacking: true,
      });

      const setupEvents = () => {
        fabricApp.on("object:modified", (e) => {
          handleObjectScaling(e);
          savePageToStore();
        });
        fabricApp.on("object:scaling", handleObjectScaling);
        fabricApp.on("text:changed", savePageToStore);
        fabricApp.on("object:removed", savePageToStore);

        fabricApp.on("selection:created", updateStoreWithActiveObject);
        fabricApp.on("selection:updated", updateStoreWithActiveObject);
        fabricApp.on("selection:cleared", () => {
          $editorStore.activeTextParams = null;
        });

        fabricApp.on("mouse:down", (options) => {
          if ($editorStore.activeTool === "TEXT" && !options.target) {
            const pointer = fabricApp.getScenePoint(options.e);
            const text = new fabric.IText("Nuevo Texto", {
              left: pointer.x,
              top: pointer.y - 12,
              fontFamily: "Helvetica",
              fontSize: 24,
              fill: "#000000",
              editable: true,
            });

            fabricApp.add(text);
            fabricApp.setActiveObject(text);
            text.enterEditing();
            text.selectAll();
            $editorStore.activeTool = "SELECT";
            savePageToStore();
          }
        });
      };

      const existing = $editorStore.pagesAnnotations[pageNumber];
      if (existing && existing.fabricJSON) {
        fabricApp.loadFromJSON(existing.fabricJSON, () => {
          fabricApp.setDimensions({ width: CSS_w, height: CSS_h });
          fabricApp.setZoom(currentZoom);
          fabricApp.requestRenderAll();
          setupEvents();
        });
      } else {
        fabricApp.setDimensions({ width: CSS_w, height: CSS_h });
        fabricApp.setZoom(currentZoom);
        setupEvents();
      }
    } else {
      fabricApp.setDimensions({ width: CSS_w, height: CSS_h });
      fabricApp.setZoom(currentZoom);
    }
  }

  function updateStoreWithActiveObject() {
    if (!fabricApp) return;
    const activeObj = fabricApp.getActiveObject();

    if (activeObj) {
      $editorStore.activeObjectParams = {
        angle: activeObj.angle || 0,
        flipX: !!activeObj.flipX,
        flipY: !!activeObj.flipY,
      };

      if (activeObj.type === "i-text" || activeObj.type === "text") {
        const textObj = activeObj as fabric.IText;
        $editorStore.activeTextParams = {
          fontFamily: textObj.fontFamily || "Helvetica",
          fontSize: textObj.fontSize || 24,
          fill: (textObj.fill as string) || "#000000",
          fontWeight: (textObj.fontWeight as string) || "normal",
          fontStyle: (textObj.fontStyle as string) || "normal",
          underline: !!textObj.underline,
        };
      } else {
        $editorStore.activeTextParams = null;
      }
    } else {
      $editorStore.activeObjectParams = null;
      $editorStore.activeTextParams = null;
    }
  }

  function handleObjectScaling(e: any) {
    const obj = e.target;
    if (!obj || (obj.type !== "i-text" && obj.type !== "text")) return;

    const scaleY = obj.scaleY || 1;
    const baseFontSize = obj.fontSize || 24;
    const effectiveFontSize = Math.round(baseFontSize * scaleY);

    if (
      $editorStore.activeTextParams &&
      $editorStore.activeTextParams.fontSize !== effectiveFontSize
    ) {
      $editorStore.activeTextParams.fontSize = effectiveFontSize;
    }

    if (e.type === "object:modified") {
      obj.set({
        fontSize: effectiveFontSize,
        scaleX: 1,
        scaleY: 1,
      });
      fabricApp.requestRenderAll();
    }
  }

  onMount(() => {
    const handleModifyObjectAct = (e: any) => {
      if (!fabricApp) return;
      const activeObj = fabricApp.getActiveObject();
      if (!activeObj) return;

      const { action, value } = e.detail;

      if (action === "rotate") {
        const currentAngle = activeObj.angle || 0;
        activeObj.set("angle", (currentAngle + value) % 360);
      } else if (action === "flipX") {
        activeObj.set("flipX", !activeObj.flipX);
      } else if (action === "flipY") {
        activeObj.set("flipY", !activeObj.flipY);
      }

      fabricApp.requestRenderAll();
      updateStoreWithActiveObject();
      savePageToStore();
    };

    const handleStyleUpdate = (e: any) => {
      if (!fabricApp) return;
      const activeObj = fabricApp.getActiveObject();
      if (
        activeObj &&
        (activeObj.type === "i-text" || activeObj.type === "text")
      ) {
        const { key, value } = e.detail;

        activeObj.set(key, value);
        fabricApp.requestRenderAll();
        savePageToStore();
      }
    };

    const handleAddImage = (e: any) => {
      if (!fabricApp || $editorStore.currentPage !== pageNumber) return;

      const { dataUrl } = e.detail;
      fabric.FabricImage.fromURL(dataUrl, { crossOrigin: "anonymous" }).then(
        (img: any) => {
          if (img.width! > fabricApp.width! * 0.6) {
            img.scaleToWidth(fabricApp.width! * 0.6);
          }
          img.set({
            left: fabricApp.width! / 2 - img.getScaledWidth() / 2,
            top: fabricApp.height! / 2 - img.getScaledHeight() / 2,
          });
          fabricApp.add(img);
          fabricApp.setActiveObject(img);
          savePageToStore();
        },
      );
    };

    const handleForceReload = () => {
      if (!fabricApp) return;

      fabricApp.off("object:modified", savePageToStore);
      fabricApp.off("text:changed", savePageToStore);
      fabricApp.off("object:removed", savePageToStore);

      const restore = () => {
        fabricApp.setZoom($editorStore.globalZoom);
        fabricApp.requestRenderAll();
        fabricApp.on("object:modified", savePageToStore);
        fabricApp.on("text:changed", savePageToStore);
        fabricApp.on("object:removed", savePageToStore);
      };

      const existing = $editorStore.pagesAnnotations[pageNumber];
      if (existing && existing.fabricJSON) {
        fabricApp.loadFromJSON(existing.fabricJSON, restore);
      } else {
        fabricApp.clear();
        restore();
      }
    };

    window.addEventListener("update-text-style", handleStyleUpdate);
    window.addEventListener("add-image", handleAddImage);
    window.addEventListener("modify-object", handleModifyObjectAct);
    window.addEventListener("force-reload-annotations", handleForceReload);

    return () => {
      window.removeEventListener("update-text-style", handleStyleUpdate);
      window.removeEventListener("add-image", handleAddImage);
      window.removeEventListener("modify-object", handleModifyObjectAct);
      window.removeEventListener("force-reload-annotations", handleForceReload);
    };
  });

  let saveTimeout: any;

  function savePageToStore() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(() => {
      const zoom = fabricApp.getZoom();
      editorStore.update((s) => {
        const newAnnotations = {
          ...s.pagesAnnotations,
          [pageNumber]: {
            viewportDimensions: {
              width: fabricApp.width! / zoom,
              height: fabricApp.height! / zoom,
            },
            fabricJSON: fabricApp.toJSON(),
          },
        };

        const newHistory = s.history.slice(0, s.historyIndex + 1);
        newHistory.push(newAnnotations);

        let newIndex = s.historyIndex + 1;
        if (newHistory.length > 40) {
          newHistory.shift();
          newIndex--;
        }

        return {
          ...s,
          pagesAnnotations: newAnnotations,
          history: newHistory,
          historyIndex: newIndex,
        };
      });
    }, 300);
  }

  onDestroy(() => {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (fabricApp) {
      try {
        fabricApp.dispose();
      } catch (e) {
        console.warn("Fabric dispose warning:", e);
      }
    }
  });
</script>

<div class="page-wrapper glass-shadow" style="width: intrinsic;">
  <canvas bind:this={baseCanvas} class="layer-base"></canvas>
  <div class="layer-fabric">
    <canvas bind:this={interactiveCanvas}></canvas>
  </div>
</div>

<style>
  .page-wrapper {
    position: relative;
    background: white;
    margin: 0 auto;
  }
  .glass-shadow {
    box-shadow: 0px 8px 30px rgba(0, 0, 0, 0.08);
  }
  .layer-base {
    display: block;
    pointer-events: none;
  }
  .layer-fabric {
    position: absolute;
    top: 0;
    left: 0;
  }
  :global(.layer-fabric .canvas-container) {
    margin: 0 !important;
  }
</style>
