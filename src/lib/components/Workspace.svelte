<script lang="ts">
  import { onMount, tick } from "svelte";
  import { editorStore } from "../store";
  import PdfPage from "./PdfPage.svelte";
  import * as pdfjsLib from "pdfjs-dist";

  let pages: pdfjsLib.PDFPageProxy[] = [];
  let loadedBytesRef: Uint8Array | null = null;
  let workspaceRef: HTMLDivElement;
  let observer: IntersectionObserver;

  $: if ($editorStore.originalPdfBytes) {
    if (
      $editorStore.originalPdfBytes !== loadedBytesRef ||
      pages.length === 0
    ) {
      loadedBytesRef = $editorStore.originalPdfBytes;
      pages = [];
      loadPdf();
    }
  }

  $: if (workspaceRef && $editorStore.currentPage) {
    const el = document.getElementById(
      `workspace-page-${$editorStore.currentPage}`,
    );
  }

  function scrollToPage(pageNumber: number) {
    const el = document.getElementById(`workspace-page-${pageNumber}`);
    if (el && workspaceRef) {
      workspaceRef.scrollTo({
        top: el.offsetTop - 40,
        behavior: "smooth",
      });
    }
  }

  onMount(() => {
    const handleScrollReq = (e: CustomEvent) =>
      scrollToPage(e.detail.pageNumber);
    window.addEventListener("request-page-scroll", handleScrollReq as any);

    observer = new IntersectionObserver(
      (entries) => {
        let maxRatio = 0;
        let mostVisiblePage = -1;

        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio;
            mostVisiblePage = parseInt(
              (entry.target as HTMLElement).dataset.pageNumber || "1",
            );
          }
        });

        if (
          mostVisiblePage !== -1 &&
          $editorStore.currentPage !== mostVisiblePage
        ) {
          $editorStore.currentPage = mostVisiblePage;
        }
      },
      {
        root: workspaceRef,
        rootMargin: "-20% 0px -20% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    return () => {
      window.removeEventListener("request-page-scroll", handleScrollReq as any);
      observer.disconnect();
    };
  });

  async function loadPdf() {
    if (!loadedBytesRef) return;

    const dataCopy = loadedBytesRef.slice();
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    const pdfDocument = await loadingTask.promise;

    $editorStore.loadedPdfDocument = pdfDocument;

    const loadedPages = [];
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      loadedPages.push(await pdfDocument.getPage(i));
    }
    pages = loadedPages;

    await tick();
    const pageElements = document.querySelectorAll(".workspace-page-wrapper");
    pageElements.forEach((el) => observer.observe(el));
  }
</script>

<div class="workspace" bind:this={workspaceRef}>
  <div class="pages-container">
    {#each pages as pageProxy, index}
      <div
        id="workspace-page-{index + 1}"
        class="workspace-page-wrapper"
        class:active-page={$editorStore.currentPage === index + 1}
        data-page-number={index + 1}
      >
        <PdfPage {pageProxy} pageNumber={index + 1} />
      </div>
    {/each}
  </div>
</div>

<style>
  .workspace {
    flex: 1;
    overflow-y: auto;
    background: #e6e6e6;
    padding: 24px;
    display: flex;
    justify-content: center;
    position: relative;
    scroll-behavior: smooth;
  }
  .pages-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding-bottom: 48px;
  }
  .workspace-page-wrapper {
    transition:
      transform 0.2s,
      box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 4px;
  }
  .workspace-page-wrapper.active-page {
    box-shadow:
      0 0 0 4px rgba(25, 118, 210, 0.5),
      0 12px 28px rgba(0, 0, 0, 0.15);
    transform: scale(1.005);
    z-index: 10;
  }
  @media (max-width: 768px) {
    .workspace {
      padding: 8px;
    }
    .pages-container {
      gap: 16px;
    }
  }
</style>
