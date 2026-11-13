<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import { search } from "../search.svelte";
  import PdfPage from "./PdfPage.svelte";
  import SearchBar from "./SearchBar.svelte";

  const PADDING = 24;

  // ── Pinch to zoom ──────────────────────────────────────────────────────────

  let pinch: { distance: number; zoom: number } | null = null;
  let pinchFrame = 0;

  function fingerDistance(event: TouchEvent): number {
    const [a, b] = [event.touches[0], event.touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function ontouchstart(event: TouchEvent) {
    if (event.touches.length === 2) pinch = { distance: fingerDistance(event), zoom: editor.zoom };
  }

  function ontouchmove(event: TouchEvent) {
    if (!pinch || event.touches.length !== 2) return;
    // Two fingers zoom the document, not the browser.
    event.preventDefault();
    const zoom = pinch.zoom * (fingerDistance(event) / Math.max(1, pinch.distance));
    cancelAnimationFrame(pinchFrame);
    pinchFrame = requestAnimationFrame(() => editor.setZoom(zoom));
  }

  function ontouchend(event: TouchEvent) {
    if (event.touches.length < 2) pinch = null;
  }

  // ── Text selected with the text tool ──────────────────────────────────────

  function onselectionchange() {
    if (editor.tool !== "textselect") return;
    const selection = document.getSelection();
    const inside = !!selection?.anchorNode && scroller?.contains(selection.anchorNode);
    editor.selectedText = selection && inside && !selection.isCollapsed ? selection.toString().trim() : "";
  }

  // Leaving the text tool drops the selection it made.
  $effect(() => {
    if (editor.tool === "textselect") return;
    untrack(() => {
      if (!editor.selectedText) return;
      document.getSelection()?.removeAllRanges();
      editor.selectedText = "";
    });
  });

  // Reordering or removing pages changes where the matches are.
  $effect(() => {
    void editor.pages;
    untrack(() => {
      if (search.open && search.query.trim()) void search.find();
    });
  });

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
      fitPage(pageId) {
        const page = editor.pages.find((p) => p.id === pageId);
        if (!page) return null;
        // The page and its caption ("Página 2 de 5") fit between the paddings.
        const caption = pageElement(pageId)?.querySelector(".caption")?.getBoundingClientRect().height ?? 18;
        const width = (scroller.clientWidth - PADDING * 2) / page.width;
        const height = (scroller.clientHeight - PADDING - caption - 8) / page.height;
        return Math.max(0.05, Math.min(width, height));
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
    // Pinching must be able to cancel the browser's own zoom, so it cannot be passive.
    scroller.addEventListener("touchstart", ontouchstart, { passive: true });
    scroller.addEventListener("touchmove", ontouchmove, { passive: false });
    scroller.addEventListener("touchend", ontouchend);
    scroller.addEventListener("touchcancel", ontouchend);
    document.addEventListener("selectionchange", onselectionchange);

    return () => {
      unregister();
      scroller.removeEventListener("wheel", onwheel);
      scroller.removeEventListener("touchstart", ontouchstart);
      scroller.removeEventListener("touchmove", ontouchmove);
      scroller.removeEventListener("touchend", ontouchend);
      scroller.removeEventListener("touchcancel", ontouchend);
      document.removeEventListener("selectionchange", onselectionchange);
      cancelAnimationFrame(pinchFrame);
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

<div class="frame">
  <SearchBar />
  <div class="workspace" bind:this={scroller} {onscroll}>
  <div class="pages" style:padding="{PADDING}px">
    {#each editor.pages as page, index (page.id)}
      <section class="slot" data-page-id={page.id}>
        <PdfPage {page} {index} active={activePages.has(page.id)} />
        <p class="caption">{t("Página {n} de {total}", { n: index + 1, total: editor.pages.length })}</p>
      </section>
    {/each}
  </div>
</div>
</div>

<style>
  .frame {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .workspace {
    position: relative;
    touch-action: pan-x pan-y;
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
