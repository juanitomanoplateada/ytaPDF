<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { editorStore } from "../store";
  import { LayoutGrid, Plus, Trash2, X } from "lucide-svelte";
  import { PDFDocument } from "pdf-lib";
  import * as pdfjsLib from "pdfjs-dist";
  import ConfirmModal from "./ConfirmModal.svelte";

  const dispatch = createEventDispatcher();

  function requestScrollTo(pageNumber: number) {
    if ($editorStore.currentPage !== pageNumber) {
      $editorStore.currentPage = pageNumber;
    }
    window.dispatchEvent(
      new CustomEvent("request-page-scroll", { detail: { pageNumber } }),
    );
  }

  let thumbnailsContainer: HTMLDivElement;

  $: if (thumbnailsContainer && $editorStore.currentPage) {
    const activeThumb = document.getElementById(
      `sidebar-thumb-${$editorStore.currentPage}`,
    );
    if (activeThumb) {
      activeThumb.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }

  function renderThumbnail(
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

        const viewport = page.getViewport({ scale: 0.3 });
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

  let pageToDelete: number | null = null;
  let showDeleteModal = false;

  function requestDeletePage(index: number, e: Event) {
    e.stopPropagation();
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
    } else if ($editorStore.currentPage === index) {
      $editorStore.currentPage = Math.max(1, index - 1);
    }
  }
</script>

<div class="sidebar" class:open={$editorStore.isMobileSidebarOpen}>
  <div class="sidebar-header">
    <button
      class="organizer-btn"
      on:click={() => {
        $editorStore.isOrganizerMode = true;
        $editorStore.isMobileSidebarOpen = false;
      }}
    >
      <LayoutGrid size={18} />
      <span>Vista de Organizador</span>
    </button>
    <button
      class="close-sidebar-btn"
      on:click={() => ($editorStore.isMobileSidebarOpen = false)}
      title="Cerrar menú"
    >
      <X size={20} />
    </button>
  </div>

  <div class="thumbnails" bind:this={thumbnailsContainer}>
    {#each Array($editorStore.numPages) as _, i}
      <div
        id="sidebar-thumb-{i + 1}"
        class="thumbnail-item"
        class:active={$editorStore.currentPage === i + 1}
        role="button"
        tabindex="0"
        on:click={() => requestScrollTo(i + 1)}
        on:keydown={(e) =>
          (e.key === "Enter" || e.key === " ") && requestScrollTo(i + 1)}
      >
        <span class="page-number">{i + 1}</span>
        <div class="thumb-box">
          <canvas
            class="thumb-base"
            use:renderThumbnail={{
              doc: $editorStore.loadedPdfDocument!,
              pageIndex: i + 1,
            }}
          ></canvas>
          <button
            class="delete-page-btn"
            title="Eliminar página"
            on:click={(e) => requestDeletePage(i + 1, e)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    {/each}

    <button class="add-pdf-btn" on:click={() => dispatch("addPdf")}>
      <Plus size={24} />
      <span>Añadir PDF...</span>
    </button>

    <div class="logo-container">
      <img src="/paty.png" alt="Paty Logo" />
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
  .sidebar {
    width: 220px;
    background: #f9f9f9;
    border-right: 1px solid #e0e0e0;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    transition: transform 0.3s ease;
  }
  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 100;
      box-shadow: 4px 0 16px rgba(0, 0, 0, 0.1);
      transform: translateX(-100%);
    }
    .sidebar.open {
      transform: translateX(0);
    }
  }
  .logo-container {
    margin-top: auto;
    width: 100%;
    padding-top: 24px;
    display: flex;
    justify-content: center;
    align-items: center;
    opacity: 0.8;
  }
  .logo-container img {
    max-width: 140px;
    height: auto;
  }
  .sidebar-header {
    width: 100%;
    margin-bottom: 24px;
    display: flex;
    justify-content: center;
    gap: 8px;
  }
  .organizer-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: white;
    border: 1px solid #ccc;
    border-radius: 8px;
    color: #333;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    width: 100%;
    justify-content: center;
  }
  .organizer-btn:hover {
    background: #f0f0f0;
    border-color: #bbb;
  }
  .add-pdf-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 120px;
    height: 160px;
    background: transparent;
    border: 2px dashed #ccc;
    border-radius: 8px;
    color: #666;
    cursor: pointer;
    transition: all 0.2s;
    margin-top: 8px;
    margin-bottom: 32px;
  }
  .add-pdf-btn:hover {
    border-color: #1976d2;
    color: #1976d2;
    background: rgba(25, 118, 210, 0.05);
  }
  .add-pdf-btn span {
    font-size: 13px;
    font-weight: 500;
  }
  .thumbnails {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .thumbnail-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
    width: 100%;
    padding: 8px 0;
    border-radius: 8px;
    transition: background-color 0.2s;
  }
  .thumbnail-item.active {
    background-color: #e3f2fd;
  }
  .thumbnail-item.active .page-number {
    color: #1976d2;
    font-weight: 600;
  }
  .thumbnail-item.active .thumb-box {
    border-color: #1976d2;
    box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.3);
  }
  .page-number {
    font-size: 13px;
    color: #666;
    margin-bottom: 6px;
  }
  .thumb-box {
    width: 120px;
    min-height: 160px;
    background: white;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
    border: 1px solid #ddd;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    display: flex;
    justify-content: center;
    transition: all 0.2s;
  }
  .thumb-base {
    max-width: 100%;
    height: auto;
    display: block;
  }

  .thumbnail-item:hover .thumb-box {
    border-color: #90caf9;
  }
  .delete-page-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(255, 0, 0, 0.8);
    color: white;
    border: none;
    border-radius: 50%;
    width: 24px;
    height: 24px;
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
  .thumbnail-item:hover .delete-page-btn {
    opacity: 1;
  }
  .close-sidebar-btn {
    display: none;
    background: transparent;
    border: none;
    color: #666;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
  }
  .close-sidebar-btn:hover {
    background: #e0e0e0;
  }
  @media (max-width: 768px) {
    .close-sidebar-btn {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .organizer-btn {
      padding: 10px 8px;
    }
    .organizer-btn span {
      display: none;
    }
  }
</style>
