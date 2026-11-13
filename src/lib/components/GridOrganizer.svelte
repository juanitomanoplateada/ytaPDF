<script lang="ts">
  import { flip } from "svelte/animate";
  import { MediaQuery, SvelteSet } from "svelte/reactivity";
  import {
    ArrowDownUp,
    ArrowLeft,
    Check,
    ChevronLeft,
    ChevronRight,
    CopyPlus,
    FileDown,
    FilePlus,
    FileText,
    ImagePlus,
    Plus,
    RotateCcw,
    RotateCw,
    Scissors,
    Trash2,
    X,
  } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import Menu from "./Menu.svelte";
  import PageThumbnail from "./PageThumbnail.svelte";
  import SplitModal from "./SplitModal.svelte";

  const compact = new MediaQuery("max-width: 768px");
  const thumbWidth = $derived(compact.current ? 136 : 168);

  /** Pages being dragged: the whole selection when the drag starts on a selected page. */
  let draggedIds = $state<string[]>([]);
  /** Insertion point in the current order (0…pages.length) while dragging pages or files. */
  let dropIndex = $state<number | null>(null);
  let draggingFiles = $state(false);
  let splitOpen = $state(false);

  let pdfInput: HTMLInputElement;
  let imageInput: HTMLInputElement;
  /** Where the files being chosen will be inserted (undefined: at the end). */
  let insertAt: number | undefined;

  const selected = new SvelteSet<string>();
  let anchorId: string | null = null;
  const selectedIds = $derived(editor.pages.filter((page) => selected.has(page.id)).map((page) => page.id));
  const dragging = $derived(draggedIds.length > 0 || draggingFiles);

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

  // ── Choosing files ───────────────────────────────────────────────────────

  function choosePdf(at?: number) {
    insertAt = at;
    pdfInput.click();
  }

  function chooseImages(at?: number) {
    insertAt = at;
    imageInput.click();
  }

  function takeFiles(event: Event): File[] {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    return files;
  }

  // ── Dragging pages and files ─────────────────────────────────────────────

  function carriesFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }

  function isPdf(file: File) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function ondragstart(event: DragEvent, pageId: string) {
    draggedIds = selected.has(pageId) && selected.size > 1 ? selectedIds : [pageId];
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedIds.join(","));
    }
  }

  function ondragover(event: DragEvent, index: number) {
    const files = draggedIds.length === 0 && carriesFiles(event);
    if (draggedIds.length === 0 && !files) return;
    event.preventDefault();
    draggingFiles = files;
    if (event.dataTransfer) event.dataTransfer.dropEffect = files ? "copy" : "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropIndex = event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
  }

  function ongridover(event: DragEvent) {
    if (draggedIds.length > 0) {
      event.preventDefault();
    } else if (carriesFiles(event)) {
      event.preventDefault();
      draggingFiles = true;
      dropIndex ??= editor.pages.length;
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  }

  function ongridleave(event: DragEvent) {
    if (!draggingFiles) return;
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) resetDrag();
  }

  async function ondrop(event: DragEvent) {
    const at = dropIndex ?? editor.pages.length;
    if (draggedIds.length > 0) {
      event.preventDefault();
      editor.movePages(draggedIds, at);
      resetDrag();
      return;
    }
    if (!carriesFiles(event)) return;
    // Files from the system go where they were dropped, not to the end.
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
    const files = [...(event.dataTransfer?.files ?? [])];
    const pdfs = files.filter(isPdf);
    const images = files.filter((file) => file.type.startsWith("image/"));
    const before = editor.pages.length;
    if (pdfs.length > 0) await editor.openFiles(pdfs, { insertAt: at });
    // Images go after the PDFs dropped with them.
    if (images.length > 0) await editor.addImagePages(images, at + (editor.pages.length - before));
  }

  function resetDrag() {
    draggedIds = [];
    dropIndex = null;
    draggingFiles = false;
  }

  function openInEditor(pageId: string) {
    editor.currentPageId = pageId;
    editor.view = "editor";
  }

  function onkeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [role='dialog'], [role='menu']")) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "a") {
      event.preventDefault();
      for (const page of editor.pages) selected.add(page.id);
    } else if (mod && key === "d" && selected.size > 0) {
      event.preventDefault();
      editor.duplicatePages(selectedIds);
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
      <span>{t("Volver al editor")}</span>
    </button>
    <div class="heading">
      <h2 id="organizer-title">{t("Organizar páginas")}</h2>
      <p>
        {t(
          "Arrastra para mover (con varias seleccionadas, se mueven juntas). Ctrl o Mayús + clic para seleccionar varias. Doble clic para editar una página.",
        )}
      </p>
    </div>
    <div class="header-actions">
      <button class="tool" onclick={() => editor.reversePages()} disabled={editor.pages.length < 2} title={t("Invertir el orden de todas las páginas")}>
        <ArrowDownUp size={18} />
        <span>{t("Invertir")}</span>
      </button>
      <button class="tool" onclick={() => (splitOpen = true)} title={t("Dividir en varios PDF por rangos o cada cierto número de páginas")}>
        <Scissors size={18} />
        <span>{t("Dividir")}</span>
      </button>
      <Menu label={t("Añadir páginas")} triggerClass="add" align="end">
        {#snippet trigger()}
          <Plus size={18} />
          <span>{t("Añadir")}</span>
        {/snippet}
        {#snippet children(close)}
          <button
            role="menuitem"
            onclick={() => {
              close();
              choosePdf();
            }}
          >
            <FileText size={18} />
            {t("PDF al final…")}
          </button>
          <button
            role="menuitem"
            onclick={() => {
              close();
              chooseImages();
            }}
          >
            <ImagePlus size={18} />
            {t("Imágenes como páginas…")}
          </button>
          <button
            role="menuitem"
            onclick={() => {
              close();
              void editor.insertBlankPage(null);
            }}
          >
            <FilePlus size={18} />
            {t("Página en blanco al final")}
          </button>
          <p class="menu-note">{t("También puedes soltar PDF o imágenes en el hueco entre dos páginas.")}</p>
        {/snippet}
      </Menu>
    </div>
  </header>

  {#if selectedIds.length > 0}
    <div class="selection-bar" role="toolbar" aria-label={t("Páginas seleccionadas")}>
      <span class="count">
        {selectedIds.length === 1 ? t("1 página seleccionada") : t("{n} páginas seleccionadas", { n: selectedIds.length })}
      </span>
      <button onclick={() => void editor.exportPages(selectedIds)}>
        <FileDown size={16} />
        {t("Exportar selección")}
      </button>
      <button onclick={() => editor.duplicatePages(selectedIds)} title={t("Duplicar (Ctrl D)")}>
        <CopyPlus size={16} />
        {t("Duplicar")}
      </button>
      <button onclick={() => editor.rotatePages(selectedIds, 270)} title={t("Girar a la izquierda")}>
        <RotateCcw size={16} />
        <span class="sr-mobile">{t("Izquierda")}</span>
      </button>
      <button onclick={() => editor.rotatePages(selectedIds, 90)} title={t("Girar a la derecha")}>
        <RotateCw size={16} />
        <span class="sr-mobile">{t("Derecha")}</span>
      </button>
      {#if selectedIds.length > 1}
        <button onclick={() => editor.reversePages(selectedIds)} title={t("Invertir el orden de las páginas seleccionadas")}>
          <ArrowDownUp size={16} />
          {t("Invertir")}
        </button>
      {/if}
      <button class="danger" onclick={() => editor.deletePages(selectedIds)}>
        <Trash2 size={16} />
        {t("Eliminar")}
      </button>
      <span class="spacer"></span>
      {#if selectedIds.length < editor.pages.length}
        <button onclick={() => editor.pages.forEach((page) => selected.add(page.id))}>{t("Seleccionar todas")}</button>
      {/if}
      <button class="icon" aria-label={t("Quitar la selección")} title={t("Quitar la selección (Esc)")} onclick={() => selected.clear()}>
        <X size={16} />
      </button>
    </div>
  {/if}

  <div class="scroll">
    <ol class="grid" class:files={draggingFiles} ondragover={ongridover} ondragleave={ongridleave} {ondrop}>
      {#each editor.pages as page, index (page.id)}
        {@const last = index === editor.pages.length - 1}
        {@const isSelected = selected.has(page.id)}
        <li
          class="card"
          class:selected={isSelected}
          class:dragging={draggedIds.includes(page.id)}
          class:drop-before={dragging && dropIndex === index}
          class:drop-after={dragging && last && dropIndex === index + 1}
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
            aria-label={t("Seleccionar la página {n}", { n: index + 1 })}
            onclick={() => toggle(page.id)}
          >
            {#if isSelected}<Check size={14} strokeWidth={3} />{/if}
          </button>
          {#if draggedIds.length > 1 && draggedIds[0] === page.id}
            <span class="drag-count" aria-hidden="true">{draggedIds.length}</span>
          {/if}
          <!-- A div rather than a button: Firefox cannot start a drag from a button. -->
          <div
            class="preview"
            role="button"
            tabindex="0"
            aria-label={t("Página {n}", { n: index + 1 })}
            aria-pressed={isSelected}
            onclick={(event) => onCardClick(event, page.id)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle(page.id);
              }
            }}
          >
            <PageThumbnail {page} width={thumbWidth} annotations={editor.renderedAnnotations[page.id]} />
          </div>
          <div class="controls">
            <button
              class="icon"
              aria-label={t("Mover la página {n} hacia atrás", { n: index + 1 })}
              title={t("Mover hacia atrás")}
              disabled={index === 0}
              onclick={() => editor.movePage(page.id, index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span class="number">{index + 1}</span>
            <button
              class="icon"
              aria-label={t("Mover la página {n} hacia delante", { n: index + 1 })}
              title={t("Mover hacia delante")}
              disabled={last}
              onclick={() => editor.movePage(page.id, index + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div class="controls secondary">
            <button
              class="icon"
              aria-label={t("Girar la página {n} a la izquierda", { n: index + 1 })}
              title={t("Girar a la izquierda")}
              onclick={() => editor.rotatePages([page.id], 270)}
            >
              <RotateCcw size={16} />
            </button>
            <button
              class="icon"
              aria-label={t("Girar la página {n} a la derecha", { n: index + 1 })}
              title={t("Girar a la derecha")}
              onclick={() => editor.rotatePages([page.id], 90)}
            >
              <RotateCw size={16} />
            </button>
            <button
              class="icon"
              aria-label={t("Duplicar la página {n}", { n: index + 1 })}
              title={t("Duplicar")}
              onclick={() => editor.duplicatePages([page.id])}
            >
              <CopyPlus size={16} />
            </button>
            <Menu label={t("Insertar después de la página {n}", { n: index + 1 })} triggerClass="card-menu" align="end">
              {#snippet trigger()}
                <FilePlus size={16} />
              {/snippet}
              {#snippet children(close)}
                <button
                  role="menuitem"
                  onclick={() => {
                    close();
                    void editor.insertBlankPage(page.id);
                  }}
                >
                  <FilePlus size={18} />
                  {t("Página en blanco")}
                </button>
                <button
                  role="menuitem"
                  onclick={() => {
                    close();
                    choosePdf(index + 1);
                  }}
                >
                  <FileText size={18} />
                  {t("PDF…")}
                </button>
                <button
                  role="menuitem"
                  onclick={() => {
                    close();
                    chooseImages(index + 1);
                  }}
                >
                  <ImagePlus size={18} />
                  {t("Imágenes…")}
                </button>
              {/snippet}
            </Menu>
            <button
              class="icon danger"
              aria-label={t("Eliminar la página {n}", { n: index + 1 })}
              title={t("Eliminar página")}
              onclick={() => editor.deletePage(page.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </li>
      {/each}
    </ol>
  </div>

  <input
    bind:this={pdfInput}
    type="file"
    accept="application/pdf,.pdf"
    multiple
    hidden
    onchange={(event) => void editor.openFiles(takeFiles(event), { insertAt })}
  />
  <input
    bind:this={imageInput}
    type="file"
    accept="image/*"
    multiple
    hidden
    onchange={(event) => void editor.addImagePages(takeFiles(event), insertAt)}
  />
</section>

{#if splitOpen}
  <SplitModal onclose={() => (splitOpen = false)} />
{/if}

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
  .header-actions {
    display: flex;
    gap: 8px;
  }
  .back,
  .tool,
  header :global(.add) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .back:hover,
  .tool:hover:not(:disabled),
  header :global(.add:hover) {
    background: var(--color-surface-muted);
  }
  .tool:disabled {
    opacity: 0.5;
    cursor: default;
  }
  header :global(.add) {
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
    border-bottom: 1px solid var(--color-primary-border);
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
    border: 1px solid var(--color-primary-border);
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
  .grid.files {
    border-radius: var(--radius-md);
    outline: 2px dashed var(--color-primary);
    outline-offset: 12px;
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
    box-shadow: var(--shadow-md), 0 0 0 1px var(--color-border-strong);
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
  .drag-count {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
    min-width: 22px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-primary);
    color: white;
    font-size: 12px;
    font-weight: 600;
    text-align: center;
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
    border: 1.5px solid var(--color-text-muted);
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
    gap: 2px;
  }
  .number {
    min-width: 32px;
    text-align: center;
    font-weight: 600;
    font-size: 13px;
  }
  .icon,
  .card :global(.card-menu) {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .icon:hover:not(:disabled),
  .card :global(.card-menu:hover) {
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

  @media (max-width: 900px) {
    .tool span,
    header :global(.add span) {
      display: none;
    }
    .tool,
    header :global(.add) {
      padding: 8px 10px;
    }
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
    .header-actions {
      margin-left: auto;
    }
    .selection-bar {
      padding: 8px 12px;
    }
    .sr-mobile {
      display: none;
    }
    .scroll {
      padding: 16px 12px 40px;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 16px;
    }
    .controls.secondary .icon,
    .card :global(.card-menu) {
      width: 26px;
    }
  }
</style>
