<script lang="ts">
  import { LayoutGrid, Plus, Trash2, X } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import PageThumbnail from "./PageThumbnail.svelte";

  let { onaddfiles }: { onaddfiles: () => void } = $props();

  let list: HTMLOListElement;

  // Keep the current page's thumbnail in view while the user scrolls the document.
  $effect(() => {
    const id = editor.currentPageId;
    if (!id) return;
    list.querySelector(`[data-thumb-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function open(pageId: string) {
    editor.goToPage(pageId);
    editor.sidebarOpen = false;
  }
</script>

<aside class="sidebar" class:open={editor.sidebarOpen} aria-label="Páginas del documento">
  <header>
    <h2>Páginas <span class="count">{editor.pages.length}</span></h2>
    <button
      class="icon"
      title="Organizar páginas"
      aria-label="Organizar páginas"
      onclick={() => {
        editor.view = "organizer";
        editor.sidebarOpen = false;
      }}
    >
      <LayoutGrid size={18} />
    </button>
    <button class="icon close" aria-label="Cerrar panel" onclick={() => (editor.sidebarOpen = false)}>
      <X size={18} />
    </button>
  </header>

  <ol class="pages" bind:this={list}>
    {#each editor.pages as page, index (page.id)}
      {@const current = page.id === editor.currentPageId}
      <li data-thumb-id={page.id} class:current>
        <button
          class="thumb"
          aria-label="Ir a la página {index + 1}"
          aria-current={current ? "page" : undefined}
          onclick={() => open(page.id)}
        >
          <PageThumbnail {page} width={132} annotations={editor.annotations[page.id]} />
        </button>
        <span class="number">{index + 1}</span>
        <button
          class="delete"
          title="Eliminar página {index + 1}"
          aria-label="Eliminar página {index + 1}"
          onclick={() => editor.deletePage(page.id)}
        >
          <Trash2 size={14} />
        </button>
      </li>
    {/each}
  </ol>

  <footer>
    <button class="add" onclick={onaddfiles}>
      <Plus size={18} />
      Añadir PDF
    </button>
  </footer>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 200px;
    flex-shrink: 0;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 12px 8px 12px 16px;
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .count {
    margin-left: 4px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-surface-muted);
    font-size: 12px;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }
  .close {
    display: none;
  }
  .pages {
    flex: 1;
    overflow-y: auto;
    margin: 0;
    padding: 16px 0;
    list-style: none;
  }
  li {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
  }
  .thumb {
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    background: none;
    box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
    cursor: pointer;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .thumb:hover {
    box-shadow: var(--shadow-md), 0 0 0 1px #c9ced6;
  }
  .current .thumb {
    border-color: var(--color-primary);
  }
  .number {
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .current .number {
    color: var(--color-primary);
    font-weight: 600;
  }
  .delete {
    position: absolute;
    top: 14px;
    right: 26px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    background: var(--color-surface);
    color: var(--color-danger);
    box-shadow: var(--shadow-md);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  li:hover .delete,
  .delete:focus-visible {
    opacity: 1;
  }
  .delete:hover {
    background: var(--color-danger-soft);
  }
  @media (hover: none) {
    .delete {
      opacity: 1;
    }
  }
  footer {
    padding: 12px;
    border-top: 1px solid var(--color-border);
  }
  .add {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px;
    border: 1px dashed #b8c0cc;
    border-radius: var(--radius-md);
    background: var(--color-surface-muted);
    color: var(--color-text-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .add:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 200;
      width: min(260px, 80vw);
      box-shadow: var(--shadow-lg);
      transform: translateX(-105%);
      transition: transform 0.25s ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .close {
      display: grid;
    }
  }
</style>
