<script lang="ts">
  import { flip } from "svelte/animate";
  import { MediaQuery } from "svelte/reactivity";
  import { ArrowLeft, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import PageThumbnail from "./PageThumbnail.svelte";

  let { onaddfiles }: { onaddfiles: () => void } = $props();

  const compact = new MediaQuery("max-width: 768px");
  const thumbWidth = $derived(compact.current ? 136 : 168);

  let draggedId = $state<string | null>(null);
  /** Insertion point in the current order (0…pages.length) while dragging. */
  let dropIndex = $state<number | null>(null);

  function indexOf(pageId: string) {
    return editor.pages.findIndex((page) => page.id === pageId);
  }

  function ondragstart(event: DragEvent, pageId: string) {
    draggedId = pageId;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", pageId);
    }
  }

  function ondragover(event: DragEvent, index: number) {
    if (!draggedId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropIndex = event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
  }

  function ondrop(event: DragEvent) {
    if (!draggedId) return;
    event.preventDefault();
    if (dropIndex !== null) {
      const from = indexOf(draggedId);
      editor.movePage(draggedId, dropIndex > from ? dropIndex - 1 : dropIndex);
    }
    resetDrag();
  }

  function resetDrag() {
    draggedId = null;
    dropIndex = null;
  }

  function openInEditor(pageId: string) {
    editor.currentPageId = pageId;
    editor.view = "editor";
  }
</script>

<section class="organizer" aria-labelledby="organizer-title">
  <header>
    <button class="back" onclick={() => (editor.view = "editor")}>
      <ArrowLeft size={18} />
      <span>Volver al editor</span>
    </button>
    <div class="heading">
      <h2 id="organizer-title">Organizar páginas</h2>
      <p>Arrastra una página para moverla o usa las flechas. Doble clic para editarla.</p>
    </div>
    <button class="add" onclick={onaddfiles}>
      <Plus size={18} />
      <span>Añadir PDF</span>
    </button>
  </header>

  <div class="scroll">
    <ol
      class="grid"
      ondragover={(event) => {
        if (draggedId) event.preventDefault();
      }}
      {ondrop}
    >
      {#each editor.pages as page, index (page.id)}
        {@const last = index === editor.pages.length - 1}
        <li
          class="card"
          class:dragging={draggedId === page.id}
          class:drop-before={draggedId !== null && dropIndex === index}
          class:drop-after={draggedId !== null && last && dropIndex === index + 1}
          draggable="true"
          animate:flip={{ duration: 200 }}
          ondragstart={(event) => ondragstart(event, page.id)}
          ondragover={(event) => ondragover(event, index)}
          ondragend={resetDrag}
          ondblclick={() => openInEditor(page.id)}
        >
          <div class="preview">
            <PageThumbnail {page} width={thumbWidth} annotations={editor.annotations[page.id]} />
          </div>
          <div class="controls">
            <button
              class="icon"
              aria-label="Mover la página {index + 1} hacia atrás"
              title="Mover hacia atrás"
              disabled={index === 0}
              onclick={() => editor.movePage(page.id, index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span class="number">{index + 1}</span>
            <button
              class="icon"
              aria-label="Mover la página {index + 1} hacia delante"
              title="Mover hacia delante"
              disabled={last}
              onclick={() => editor.movePage(page.id, index + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <button
              class="icon danger"
              aria-label="Eliminar la página {index + 1}"
              title="Eliminar página"
              onclick={() => editor.deletePage(page.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </li>
      {/each}
    </ol>
  </div>
</section>

<style>
  .organizer {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    background: var(--color-surface-muted);
  }
  header {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 12px 24px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  .heading {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .heading p {
    margin: 2px 0 0;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .back,
  .add {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .back:hover,
  .add:hover {
    background: var(--color-surface-muted);
  }
  .add {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 28px 24px 48px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    gap: 24px;
    margin: 0 auto;
    padding: 0;
    max-width: 1400px;
    list-style: none;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
    cursor: grab;
    user-select: none;
    transition:
      box-shadow 0.15s,
      opacity 0.15s;
  }
  .card:hover {
    box-shadow: var(--shadow-md), 0 0 0 1px #c9ced6;
  }
  .card.dragging {
    opacity: 0.4;
  }
  .card.drop-before::before,
  .card.drop-after::after {
    content: "";
    position: absolute;
    top: 8px;
    bottom: 8px;
    width: 4px;
    border-radius: 2px;
    background: var(--color-primary);
  }
  .card.drop-before::before {
    left: -14px;
  }
  .card.drop-after::after {
    right: -14px;
  }
  .preview {
    box-shadow: 0 0 0 1px var(--color-border);
    pointer-events: none;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .number {
    min-width: 32px;
    text-align: center;
    font-weight: 600;
    font-size: 13px;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }
  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon.danger {
    margin-left: 6px;
    color: var(--color-danger);
  }
  .icon.danger:hover {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }

  @media (max-width: 768px) {
    header {
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px 16px;
    }
    .heading {
      order: 3;
      flex-basis: 100%;
    }
    .add {
      margin-left: auto;
    }
    .scroll {
      padding: 16px 12px 40px;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 16px;
    }
  }
</style>
