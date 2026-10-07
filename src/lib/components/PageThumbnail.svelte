<script lang="ts">
  import { untrack } from "svelte";
  import { editor, type PageAnnotations, type PageRef } from "../editor.svelte";
  import { isRenderCancelled } from "../pdfjs";
  import { renderThumbnail } from "../thumbnails";

  interface Props {
    page: PageRef;
    width: number;
    annotations?: PageAnnotations;
  }

  let { page, width, annotations }: Props = $props();

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let visible = $state(false);
  let ready = $state(false);

  const height = $derived((width * page.height) / page.width);

  $effect(() => {
    // Thumbnails render only near the visible part of their scroll container.
    const observer = new IntersectionObserver(
      ([entry]) => (visible = entry.isIntersecting),
      { rootMargin: "400px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!visible) return;
    const data = annotations;
    const ref = page;
    const cssWidth = width;
    const formRevision = editor.formRevision[ref.sourceId] ?? 0;
    const source = editor.sources.get(ref.sourceId);
    if (!source) return;

    const controller = new AbortController();
    // Repaints caused by editing are debounced; the first paint is immediate.
    const delay = untrack(() => ready) ? 250 : 0;
    const timer = setTimeout(() => {
      renderThumbnail(canvas, source, ref, cssWidth, data, formRevision, untrack(() => editor.formValues[ref.sourceId] ?? {}), controller.signal)
        .then(() => {
          if (!controller.signal.aborted) ready = true;
        })
        .catch((error) => {
          if (!controller.signal.aborted && !isRenderCancelled(error)) {
            console.error("Error al generar la miniatura:", error);
          }
        });
    }, delay);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
</script>

<div class="thumbnail" bind:this={container} style:width="{width}px" style:height="{height}px">
  <canvas bind:this={canvas} class:ready style:width="{width}px" style:height="{height}px"></canvas>
</div>

<style>
  .thumbnail {
    position: relative;
    overflow: hidden;
    background: white;
  }
  canvas {
    display: block;
    opacity: 0;
    transition: opacity 0.15s;
  }
  canvas.ready {
    opacity: 1;
  }
</style>
