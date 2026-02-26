<script lang="ts">
  import { editorStore } from "../store";
  import * as fabric from "fabric";
  import { ArrowLeft, Trash2 } from "lucide-svelte";
  import { PDFDocument } from "pdf-lib";
  import * as pdfjsLib from "pdfjs-dist";
  import ConfirmModal from "./ConfirmModal.svelte";

  let draggedIndex: number | null = null;
  let dropTargetIndex: number | null = null;
  let dropPosition: "left" | "right" | null = null;

  function renderGridThumbnail(
    node: HTMLCanvasElement,
    params: { doc: pdfjsLib.PDFDocumentProxy; pageIndex: number },
  ) {
    let renderTask: any;
    let isActive = true;

    async function paint() {
      if (!params.doc) return;
      try {
        const page = await params.doc.getPage(params.pageIndex);
        if (!isActive) return;

        const viewport = page.getViewport({ scale: 0.4 });
        node.width = viewport.width;
        node.height = viewport.height;

        const ctx = node.getContext("2d");
        if (ctx) {
          renderTask = page.render({ canvasContext: ctx, viewport } as any);
          await renderTask.promise;
        }
      } catch (err: any) {}
    }

    paint();

    return {
      update(newParams: { doc: pdfjsLib.PDFDocumentProxy; pageIndex: number }) {
        if (renderTask) renderTask.cancel();
        params = newParams;
        paint();
      },
      destroy() {
        isActive = false;
        if (renderTask) renderTask.cancel();
      },
    };
  }

  function renderGridOverlay(
    node: HTMLCanvasElement,
    params: {
      annotation: any;
      width: number;
      height: number;
    },
  ) {
    let staticCanvas: fabric.StaticCanvas;

    function paint() {
      if (!params.width || !params.height) return;
      node.width = params.width;
      node.height = params.height;

      const ctx = node.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, node.width, node.height);

      if (params.annotation && params.annotation.fabricJSON) {
        if (!staticCanvas) staticCanvas = new fabric.StaticCanvas(node);

        staticCanvas.loadFromJSON(params.annotation.fabricJSON, () => {
          const ratioX =
            node.width / params.annotation.viewportDimensions.width;
          const ratioY =
            node.height / params.annotation.viewportDimensions.height;

          const objects = staticCanvas.getObjects();
          objects.forEach((obj: any) => {
            obj.scaleX = (obj.scaleX || 1) * ratioX;
            obj.scaleY = (obj.scaleY || 1) * ratioY;
            obj.left = (obj.left || 0) * ratioX;
            obj.top = (obj.top || 0) * ratioY;
            obj.setCoords();
          });
          staticCanvas.renderAll();
        });
      } else if (staticCanvas) {
        staticCanvas.clear();
      }
    }

    paint();

    return {
      update(newParams: any) {
        params = newParams;
        paint();
      },
      destroy() {
        if (staticCanvas) staticCanvas.dispose();
      },
    };
  }

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";

      e.dataTransfer.setData("text/plain", index.toString());
    }
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (draggedIndex === index) return;

    dropTargetIndex = index;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 2) {
      dropPosition = "left";
    } else {
      dropPosition = "right";
    }
  }

  async function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) {
      dropTargetIndex = null;
      return;
    }

    const fromIndex = draggedIndex;
    const toIndex = targetIndex;

    draggedIndex = null;
    dropTargetIndex = null;

    if (!$editorStore.originalPdfBytes) return;

    const oldAnnotations = { ...$editorStore.pagesAnnotations };
    const newAnnotations: typeof oldAnnotations = {};

    const pageMapping: number[] = [];
    for (let i = 1; i <= $editorStore.numPages; i++) {
      pageMapping.push(i);
    }

    let insertAt = toIndex - 1;
    if (dropPosition === "right") {
      insertAt += 1;
    }

    const removeIndex = fromIndex - 1;
    const [moved] = pageMapping.splice(removeIndex, 1);

    if (insertAt > removeIndex) {
      insertAt -= 1;
    }

    pageMapping.splice(insertAt, 0, moved);

    for (let i = 0; i < pageMapping.length; i++) {
      const oldPageNum = pageMapping[i];
      const newPageNum = i + 1;
      if (oldAnnotations[oldPageNum]) {
        newAnnotations[newPageNum] = oldAnnotations[oldPageNum];
      }
    }

    $editorStore.pagesAnnotations = newAnnotations;
    $editorStore.history = [newAnnotations];
    $editorStore.historyIndex = 0;

    const pdfDoc = await PDFDocument.load($editorStore.originalPdfBytes!);

    const pageToMove = fromIndex - 1;
    const targetSpot = toIndex - 1;

    const newPdf = await PDFDocument.create();

    const indicesToCopy = pageMapping.map((num) => num - 1);

    const copiedPages = await newPdf.copyPages(pdfDoc, indicesToCopy);
    copiedPages.forEach((p) => newPdf.addPage(p));

    const finalBytes = await newPdf.save();

    $editorStore.originalPdfBytes = finalBytes;

    const loadingTask = pdfjsLib.getDocument({ data: finalBytes.slice() });
    const newPdfDocument = await loadingTask.promise;
    $editorStore.loadedPdfDocument = newPdfDocument;
  }

  let pageToDelete: number | null = null;
  let showDeleteModal = false;

  function requestDeletePage(index: number) {
    if (!$editorStore.originalPdfBytes) return;
    pageToDelete = index;
    showDeleteModal = true;
  }

  function cancelDelete() {
    showDeleteModal = false;
    pageToDelete = null;
  }

  async function confirmDelete() {
    if (pageToDelete === null) return;

    const index = pageToDelete;
    showDeleteModal = false;
    pageToDelete = null;

    if ($editorStore.numPages <= 1) {
      $editorStore.originalPdfBytes = null;
      $editorStore.loadedPdfDocument = null;
      $editorStore.numPages = 0;
      $editorStore.currentPage = 1;
      $editorStore.pagesAnnotations = {};
      $editorStore.history = [{}];
      $editorStore.historyIndex = 0;
      $editorStore.documentId = "";
      $editorStore.isOrganizerMode = false;
      return;
    }

    const oldAnnotations = { ...$editorStore.pagesAnnotations };
    const newAnnotations: typeof oldAnnotations = {};

    const pageMapping: number[] = [];
    for (let i = 1; i <= $editorStore.numPages; i++) {
      if (i !== index) {
        pageMapping.push(i);
      }
    }

    for (let i = 0; i < pageMapping.length; i++) {
      const oldPageNum = pageMapping[i];
      const newPageNum = i + 1;
      if (oldAnnotations[oldPageNum]) {
        newAnnotations[newPageNum] = oldAnnotations[oldPageNum];
      }
    }

    $editorStore.pagesAnnotations = newAnnotations;
    $editorStore.history = [newAnnotations];
    $editorStore.historyIndex = 0;

    const pdfDoc = await PDFDocument.load($editorStore.originalPdfBytes!);
    pdfDoc.removePage(index - 1);

    const finalBytes = await pdfDoc.save();
    $editorStore.originalPdfBytes = finalBytes;

    const loadingTask = pdfjsLib.getDocument({ data: finalBytes.slice() });
    const newPdfDocument = await loadingTask.promise;
    $editorStore.loadedPdfDocument = newPdfDocument;
    $editorStore.numPages = newPdfDocument.numPages;

    if ($editorStore.currentPage > newPdfDocument.numPages) {
      $editorStore.currentPage = newPdfDocument.numPages;
    }
  }
</script>

<div class="organizer-container">
  <div class="header">
    <div class="header-left">
      <button
        class="back-btn"
        on:click={() => ($editorStore.isOrganizerMode = false)}
      >
        <ArrowLeft size={20} />
        <span>Volver al Editor</span>
      </button>
      <h2>Organizador de Páginas</h2>
    </div>
  </div>

  <div class="grid-scroll-area">
    <div class="grid" role="list">
      {#each Array($editorStore.numPages) as _, i}
        <div
          class="grid-item"
          role="listitem"
          class:dragging={draggedIndex === i + 1}
          class:drop-target-left={dropTargetIndex === i + 1 &&
            dropPosition === "left"}
          class:drop-target-right={dropTargetIndex === i + 1 &&
            dropPosition === "right"}
          draggable="true"
          on:dragstart={(e) => handleDragStart(e, i + 1)}
          on:dragover={(e) => handleDragOver(e, i + 1)}
          on:drop={(e) => handleDrop(e, i + 1)}
          on:dragenter={() => (dropTargetIndex = i + 1)}
          on:dragleave={() => {
            if (dropTargetIndex === i + 1) {
              dropTargetIndex = null;
              dropPosition = null;
            }
          }}
        >
          <div class="page-number-badge">{i + 1}</div>
          <div class="canvas-wrapper">
            <canvas
              class="grid-base"
              use:renderGridThumbnail={{
                doc: $editorStore.loadedPdfDocument!,
                pageIndex: i + 1,
              }}
            ></canvas>
            <canvas
              class="grid-overlay"
              use:renderGridOverlay={{
                annotation: $editorStore.pagesAnnotations[i + 1],

                width: 200,
                height: 282,
              }}
            ></canvas>
            <button
              class="delete-page-btn"
              title="Eliminar página"
              on:click|stopPropagation={() => requestDeletePage(i + 1)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>

{#if showDeleteModal}
  <ConfirmModal
    title="Eliminar Página"
    message={`¿Estás seguro de que deseas eliminar la página ${pageToDelete}? Esta acción no se puede deshacer.`}
    on:confirm={confirmDelete}
    on:cancel={cancelDelete}
  />
{/if}

<style>
  .organizer-container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #f0f2f5;
  }
  .header {
    height: 64px;
    background: white;
    border-bottom: 1px solid #e0e0e0;
    display: flex;
    align-items: center;
    padding: 0 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: #333;
  }
  .back-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: transparent;
    border: 1px solid #ccc;
    border-radius: 8px;
    color: #333;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
  }
  .back-btn:hover {
    background: #f5f5f5;
  }
  .grid-scroll-area {
    flex: 1;
    overflow-y: auto;
    padding: 40px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 32px;
    max-width: 1400px;
    margin: 0 auto;
  }
  .grid-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: grab;
    transition:
      transform 0.2s,
      box-shadow 0.2s;
    position: relative;
  }
  .grid-item:active {
    cursor: grabbing;
  }
  .grid-item.dragging {
    opacity: 0.4;
    transform: scale(0.95);
  }
  .grid-item.drop-target-left .canvas-wrapper {
    border-left: 6px solid #1976d2;
    box-shadow:
      -8px 0 16px rgba(25, 118, 210, 0.3),
      0 8px 24px rgba(0, 0, 0, 0.15);
    transform: translateX(8px) scale(0.98);
    border-top-left-radius: 2px;
    border-bottom-left-radius: 2px;
  }
  .grid-item.drop-target-right .canvas-wrapper {
    border-right: 6px solid #1976d2;
    box-shadow:
      8px 0 16px rgba(25, 118, 210, 0.3),
      0 8px 24px rgba(0, 0, 0, 0.15);
    transform: translateX(-8px) scale(0.98);
    border-top-right-radius: 2px;
    border-bottom-right-radius: 2px;
  }
  .page-number-badge {
    background: #333;
    color: white;
    font-size: 12px;
    font-weight: bold;
    padding: 4px 12px;
    border-radius: 12px;
    margin-bottom: 12px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  .canvas-wrapper {
    width: 100%;
    aspect-ratio: 1 / 1.414;
    background: white;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    border: 2px solid transparent;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    transition: all 0.2s;
  }
  .grid-item:hover .canvas-wrapper {
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  }
  .grid-base {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  .grid-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .delete-page-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgba(255, 0, 0, 0.8);
    color: white;
    border: none;
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.2s,
      background 0.2s;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  .delete-page-btn:hover {
    background: rgba(255, 0, 0, 1);
  }
  .grid-item:hover .delete-page-btn {
    opacity: 1;
  }
  @media (max-width: 600px) {
    .header {
      padding: 0 16px;
    }
    .header h2 {
      display: none;
    }
    .grid-scroll-area {
      padding: 16px;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 16px;
    }
  }
</style>
