<script lang="ts">
  import { flip } from "svelte/animate";
  import { MediaQuery, SvelteSet } from "svelte/reactivity";
  import {
    ArrowLeft,
    Check,
    ChevronLeft,
    ChevronRight,
    FileDown,
    FilePlus,
    Plus,
    RotateCw,
    Trash2,
    X,
  } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import PageThumbnail from "./PageThumbnail.svelte";

  let { onaddfiles }: { onaddfiles: () => void } = $props();

  const compact = new MediaQuery("max-width: 768px");
  const thumbWidth = $derived(compact.current ? 136 : 168);

  let draggedId = $state<string | null>(null);
  /** Insertion point in the current order (0…pages.length) while dragging. */
  let dropIndex = $state<number | null>(null);

  const selected = new SvelteSet<string>();
  let anchorId: string | null = null;
  const selectedIds = $derived(editor.pages.filter((page) => selected.has(page.id)).map((page) => page.id));

  // Forget selected pages that no longer exist (deleted or undone).
  $effect(() => {
    const ids = new Set(editor.pages.map((page) => page.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
  });

  function indexOf(pageId: string) {
    return editor.pages.findIndex((page) => page.id === pageId);
  }

  function onCardClick(event: MouseEvent, pageId: string) {
    if (event.shiftKey && anchorId) {
      const [from, to] = [indexOf(anchorId), indexOf(pageId)].sort((a, b) => a - b);
      if (!(event.ctrlKey || event.metaKey)) selected.clear();
      for (const page of editor.pages.slice(from, to + 1)) selected.add(page.id);
      return;
    }
    if (event.ctrlKey || event.metaKey) toggle(pageId);
    else {
      selected.clear();
      selected.add(pageId);
    }
    anchorId = pageId;
  }

  function toggle(pageId: string) {
    if (selected.has(pageId)) selected.delete(pageId);
    else selected.add(pageId);
    anchorId = pageId;
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

  function onkeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [role='dialog']")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      for (const page of editor.pages) selected.add(page.id);
    } else if (event.key === "Escape" && selected.size > 0) {
      selected.clear();
    } else if ((event.key === "Delete" || event.key === "Backspace") && selected.size > 0) {
      event.preventDefault();
      editor.deletePages(selectedIds);
    }
  }
</script>

<svelte:window {onkeydown} />

<section class="organizer" aria-labelledby="organizer-title">
  <header>
    <button class="back" onclick={() => (editor.view = "editor")}>
      <ArrowLeft size={18} />
      <span>Volver al editor</span>
    </button>
    <div class="heading">
      <h2 id="organizer-title">Organizar páginas</h2>
      <p>Arrastra para mover. Ctrl o Mayús + clic para seleccionar varias. Doble clic para editar una página.</p>
    </div>
    <button class="add" onclick={onaddfiles}>
      <Plus size={18} />
      <span>Añadir PDF</span>
    </button>
  </header>

  {#if selectedIds.length > 0}
    <div class="selection-bar" role="toolbar" aria-label="Páginas seleccionadas">
      <span class="count">
        {selectedIds.length === 1 ? "1 página seleccionada" : `${selectedIds.length} páginas seleccionadas`}
      </span>
      <button onclick={() => void editor.exportPages(selectedIds)}>
        <FileDown size={16} />
        Exportar selección
      </button>
      <button onclick={() => editor.rotatePages(selectedIds, 90)}>
        <RotateCw size={16} />
        Girar
      </button>
      <button class="danger" onclick={() => editor.deletePages(selectedIds)}>
        <Trash2 size={16} />
        Eliminar
      </button>
      <span class="spacer"></span>
      {#if selectedIds.length < editor.pages.length}
        <button onclick={() => editor.pages.forEach((page) => selected.add(page.id))}>Seleccionar todas</button>
      {/if}
      <button class="icon" aria-label="Quitar la selección" title="Quitar la selección (Esc)" onclick={() => selected.clear()}>
        <X size={16} />
      </button>
    </div>
  {/if}

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
        {@const isSelected = selected.has(page.id)}
        <li
          class="card"
          class:selected={isSelected}
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
          <button
            class="check"
            class:checked={isSelected}
            role="checkbox"
            aria-checked={isSelected}
            aria-label="Seleccionar la página {index + 1}"
            onclick={() => toggle(page.id)}
          >
            {#if isSelected}<Check size={14} strokeWidth={3} />{/if}
          </button>
          <!-- A div rather than a button: Firefox cannot start a drag from a button. -->
          <div
            class="preview"
            role="button"
            tabindex="0"
            aria-label="Página {index + 1}"
            aria-pressed={isSelected}
            onclick={(event) => onCardClick(event, page.id)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle(page.id);
              }
            }}
          >
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
          </div>
          <div class="controls secondary">
            <button
              class="icon"
              aria-label="Girar la página {index + 1}"
              title="Girar 90°"
              onclick={() => editor.rotatePages([page.id], 90)}
            >
              <RotateCw size={16} />
            </button>
            <button
              class="icon"
              aria-label="Insertar una página en blanco después de la {index + 1}"
              title="Insertar página en blanco después"
              onclick={() => void editor.insertBlankPage(page.id)}
            >
              <FilePlus size={16} />
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
  .selection-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 24px;
    background: var(--color-primary-soft);
    border-bottom: 1px solid #bcd9f5;
  }
  .selection-bar .count {
    margin-right: 8px;
    font-weight: 600;
    color: var(--color-primary);
  }
  .selection-bar button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid #bcd9f5;
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font-weight: 500;
    cursor: pointer;
  }
  .selection-bar button:hover {
    border-color: var(--color-primary);
  }
  .selection-bar button.danger {
    color: var(--color-danger);
  }
  .selection-bar .icon {
    padding: 6px;
  }
  .spacer {
    flex: 1;
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
    gap: 8px;
    padding: 12px 12px 8px;
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
  .card.selected {
    box-shadow: var(--shadow-md), 0 0 0 2px var(--color-primary);
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
  .check {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1.5px solid #9aa4b2;
    border-radius: 6px;
    background: var(--color-surface);
    color: white;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .card:hover .check,
  .check:focus-visible,
  .check.checked {
    opacity: 1;
  }
  .check.checked {
    border-color: var(--color-primary);
    background: var(--color-primary);
  }
  @media (hover: none) {
    .check {
      opacity: 1;
    }
  }
  .preview {
    box-shadow: 0 0 0 1px var(--color-border);
    cursor: inherit;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .controls.secondary {
    gap: 4px;
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
    .selection-bar {
      padding: 8px 12px;
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
