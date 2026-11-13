<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { Bookmark as BookmarkIcon, ChevronRight, Files, LayoutGrid, Plus, Trash2, X } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import type { Bookmark } from "../outline";
  import PageThumbnail from "./PageThumbnail.svelte";

  let { onaddfiles }: { onaddfiles: () => void } = $props();

  let list = $state<HTMLOListElement>();
  /** Bookmarks shown open, by id. */
  const expanded = new SvelteSet<string>();

  // Keep the current page's thumbnail in view while the user scrolls the document.
  $effect(() => {
    const id = editor.currentPageId;
    if (!id || !list) return;
    list.querySelector(`[data-thumb-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function open(pageId: string) {
    editor.goToPage(pageId);
    editor.sidebarOpen = false;
  }

  function pageNumber(pageId: string | null): number | null {
    if (!pageId) return null;
    const index = editor.pages.findIndex((page) => page.id === pageId);
    return index >= 0 ? index + 1 : null;
  }

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }
</script>

{#snippet tree(items: Bookmark[], depth: number)}
  <ul class="tree" role={depth === 0 ? "tree" : "group"}>
    {#each items as item (item.id)}
      {@const number = pageNumber(item.pageId)}
      {@const isOpen = expanded.has(item.id)}
      <li role="treeitem" aria-expanded={item.children.length > 0 ? isOpen : undefined} aria-selected="false">
        <div class="bookmark" style:padding-left="{8 + depth * 14}px">
          {#if item.children.length > 0}
            <button
              class="twisty"
              class:open={isOpen}
              aria-label={isOpen ? t("Contraer") : t("Desplegar")}
              onclick={() => toggle(item.id)}
            >
              <ChevronRight size={14} />
            </button>
          {:else}
            <span class="twisty-space"></span>
          {/if}
          <button
            class="title"
            disabled={number === null}
            title={number === null ? t("La página de este marcador ya no está en el documento") : item.title}
            onclick={() => item.pageId && open(item.pageId)}
          >
            <span class="text">{item.title}</span>
            {#if number !== null}<span class="page">{number}</span>{/if}
          </button>
        </div>
        {#if isOpen && item.children.length > 0}
          {@render tree(item.children, depth + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<aside class="sidebar" class:open={editor.sidebarOpen} aria-label={t("Páginas del documento")}>
  <header>
    <div class="tabs" role="tablist">
      <button
        role="tab"
        aria-selected={editor.sidebarTab === "pages"}
        title={t("Páginas")}
        onclick={() => (editor.sidebarTab = "pages")}
      >
        <Files size={16} />
        <span class="count">{editor.pages.length}</span>
      </button>
      <button
        role="tab"
        aria-selected={editor.sidebarTab === "bookmarks"}
        title={t("Marcadores")}
        aria-label={t("Marcadores")}
        onclick={() => (editor.sidebarTab = "bookmarks")}
      >
        <BookmarkIcon size={16} />
      </button>
    </div>
    <button
      class="icon"
      title={t("Organizar páginas")}
      aria-label={t("Organizar páginas")}
      onclick={() => {
        editor.view = "organizer";
        editor.sidebarOpen = false;
      }}
    >
      <LayoutGrid size={18} />
    </button>
    <button class="icon close" aria-label={t("Cerrar panel")} onclick={() => (editor.sidebarOpen = false)}>
      <X size={18} />
    </button>
  </header>

  {#if editor.sidebarTab === "bookmarks"}
    <div class="bookmarks">
      {#if editor.bookmarks.length === 0}
        <p class="empty">{t("Este documento no tiene marcadores. Al unir varios PDF, cada uno tiene el suyo.")}</p>
      {:else}
        {@render tree(editor.bookmarks, 0)}
      {/if}
    </div>
  {:else}
    <ol class="pages" bind:this={list}>
      {#each editor.pages as page, index (page.id)}
        {@const current = page.id === editor.currentPageId}
        <li data-thumb-id={page.id} class:current>
          <button
            class="thumb"
            aria-label={t("Ir a la página {n}", { n: index + 1 })}
            aria-current={current ? "page" : undefined}
            onclick={() => open(page.id)}
          >
            <PageThumbnail {page} width={132} annotations={editor.renderedAnnotations[page.id]} />
          </button>
          <span class="number">{index + 1}</span>
          <button
            class="delete"
            title={t("Eliminar página {n}", { n: index + 1 })}
            aria-label={t("Eliminar página {n}", { n: index + 1 })}
            onclick={() => editor.deletePage(page.id)}
          >
            <Trash2 size={14} />
          </button>
        </li>
      {/each}
    </ol>
  {/if}

  <footer>
    <button class="add" onclick={onaddfiles}>
      <Plus size={18} />
      {t("Añadir PDF")}
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
    padding: 8px 8px 8px 10px;
    border-bottom: 1px solid var(--color-border);
  }
  .tabs {
    display: flex;
    flex: 1;
    gap: 2px;
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .tabs button:hover {
    background: var(--color-surface-muted);
  }
  .tabs button[aria-selected="true"] {
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .count {
    font-size: 12px;
    font-weight: 600;
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
  }
  .pages li {
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
    box-shadow: var(--shadow-md), 0 0 0 1px var(--color-border-strong);
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
  .pages li:hover .delete,
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
  .bookmarks {
    flex: 1;
    overflow: auto;
    padding: 8px 4px 16px 0;
  }
  .empty {
    margin: 12px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .tree {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bookmark {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .twisty,
  .twisty-space {
    display: grid;
    place-items: center;
    width: 20px;
    height: 24px;
    flex-shrink: 0;
  }
  .twisty {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: transform 0.15s;
  }
  .twisty.open {
    transform: rotate(90deg);
  }
  .title {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding: 4px 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--color-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .title:hover:not(:disabled) {
    background: var(--color-surface-muted);
  }
  .title:disabled {
    color: var(--color-text-muted);
    cursor: default;
  }
  .title .text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title .page {
    color: var(--color-text-muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
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
    border: 1px dashed var(--color-border-dashed);
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
