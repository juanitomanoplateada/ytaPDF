<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { editor } from "../editor.svelte";
  import PdfPage from "./PdfPage.svelte";

  const PADDING = 24;

  let scroller: HTMLDivElement;
  /** Pages near the viewport: only these get canvases and Fabric instances. */
  const activePages = new SvelteSet<string>();
  let frame = 0;
  let ignoreScrollUntil = 0;

  function pageElement(pageId: string) {
    return scroller.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
  }

  // Re-observe page slots whenever the page list changes.
  $effect(() => {
    void editor.pages;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.pageId;
          if (!id) continue;
          if (entry.isIntersecting) activePages.add(id);
          else activePages.delete(id);
        }
      },
      { root: scroller, rootMargin: "100% 0px" },
    );
    for (const element of scroller.querySelectorAll("[data-page-id]")) observer.observe(element);
    return () => observer.disconnect();
  });

  function updateCurrentPage() {
    frame = 0;
    if (performance.now() < ignoreScrollUntil) return;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const readingLine = scroller.scrollTop + scroller.clientHeight * 0.35;
    let current: string | undefined;
    for (const element of scroller.querySelectorAll<HTMLElement>("[data-page-id]")) {
      if (!atBottom && element.offsetTop > readingLine) break;
      current = element.dataset.pageId;
    }
    if (current && current !== editor.currentPageId) editor.currentPageId = current;
  }

  function onscroll() {
    if (!frame) frame = requestAnimationFrame(updateCurrentPage);
  }

  onMount(() => {
    const unregister = editor.registerViewport({
      scrollToPage(pageId, smooth) {
        const element = pageElement(pageId);
        if (!element) return;
        // Let the scroll animation finish before tracking the current page again.
        ignoreScrollUntil = performance.now() + (smooth ? 700 : 50);
        scroller.scrollTo({ top: element.offsetTop - PADDING / 2, behavior: smooth ? "smooth" : "auto" });
      },
      fitWidth() {
        const widest = Math.max(...editor.pages.map((page) => page.width));
        return widest > 0 ? (scroller.clientWidth - PADDING * 2) / widest : null;
      },
    });

    // Pages wider than the screen (phones, large formats) start fitted.
    const widest = Math.max(...editor.pages.map((page) => page.width));
    if (editor.zoom === 1 && widest * editor.zoom > scroller.clientWidth - PADDING * 2) {
      editor.fitWidth();
    }
    if (editor.currentPageId && editor.currentPageIndex > 0) {
      editor.goToPage(editor.currentPageId, false);
    }

    // Ctrl/⌘ + wheel (and trackpad pinch) zooms the document, not the browser.
    const onwheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      editor.setZoom(editor.zoom * Math.exp(-event.deltaY * 0.002));
    };
    scroller.addEventListener("wheel", onwheel, { passive: false });

    return () => {
      unregister();
      scroller.removeEventListener("wheel", onwheel);
      cancelAnimationFrame(frame);
    };
  });

  // Keep the same spot of the current page centred when the zoom changes.
  let anchor: { pageId: string; y: number; x: number } | null = null;

  $effect.pre(() => {
    void editor.zoom;
    untrack(() => {
      const pageId = editor.currentPageId;
      const element = scroller && pageId ? pageElement(pageId) : null;
      if (!element || element.offsetHeight === 0) return;
      anchor = {
        pageId: pageId!,
        y: (scroller.scrollTop + scroller.clientHeight / 2 - element.offsetTop) / element.offsetHeight,
        x: (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth),
      };
    });
  });

  $effect(() => {
    void editor.zoom;
    const saved = anchor;
    anchor = null;
    if (!saved) return;
    const element = pageElement(saved.pageId);
    if (!element) return;
    ignoreScrollUntil = performance.now() + 50;
    scroller.scrollTop = element.offsetTop + saved.y * element.offsetHeight - scroller.clientHeight / 2;
    scroller.scrollLeft = saved.x * scroller.scrollWidth - scroller.clientWidth / 2;
  });
</script>

<div class="workspace" bind:this={scroller} {onscroll}>
  <div class="pages" style:padding="{PADDING}px">
    {#each editor.pages as page, index (page.id)}
      <section class="slot" data-page-id={page.id}>
        <PdfPage {page} {index} active={activePages.has(page.id)} />
        <p class="caption">Página {index + 1} de {editor.pages.length}</p>
      </section>
    {/each}
  </div>
</div>

<style>
  .workspace {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: auto;
    background: var(--color-canvas);
    overscroll-behavior: contain;
  }
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    width: max-content;
    min-width: 100%;
  }
  .slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .caption {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 768px) {
    .pages {
      gap: 12px;
    }
  }
</style>
