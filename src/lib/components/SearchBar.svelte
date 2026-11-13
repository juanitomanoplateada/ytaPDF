<script lang="ts">
  import { ChevronDown, ChevronUp, EyeOff, Replace, ReplaceAll, Search as SearchIcon, X } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import { search } from "../search.svelte";

  let input = $state<HTMLInputElement>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let replacing = $state(false);
  let replacement = $state("");
  let working = $state(false);

  const canAct = $derived(search.query.trim() !== "" && !working && !editor.busy);

  async function replaceAll() {
    if (!canAct) return;
    working = true;
    try {
      const count = await editor.replaceText(search.query, replacement);
      // The highlights show the original text, which is now replaced.
      if (count > 0) search.clearMatches();
    } finally {
      working = false;
    }
  }

  async function redactAll() {
    if (!canAct) return;
    working = true;
    try {
      const count = await editor.redactText(search.query);
      if (count > 0) search.clearMatches();
    } finally {
      working = false;
    }
  }

  function onReplaceKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void replaceAll();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      search.close();
    }
  }

  // Focus (and select) the box every time the search opens.
  $effect(() => {
    if (search.open && input) {
      input.focus();
      input.select();
    }
  });

  function oninput(event: Event) {
    const query = (event.currentTarget as HTMLInputElement).value;
    search.query = query;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void search.find(query);
    }, 200);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        void search.find();
      } else if (event.shiftKey) search.previous();
      else search.next();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      search.close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      input?.select();
    }
  }

  const status = $derived(
    !search.query.trim() || search.cleared
      ? ""
      : search.searching
        ? t("Buscando…")
        : search.matches.length === 0
          ? t("Sin resultados")
          : t("{n} de {total}", { n: search.current + 1, total: search.matches.length }),
  );
</script>

{#if search.open}
  <div class="search" role="search">
    <div class="row">
      <SearchIcon size={16} />
      <input
        bind:this={input}
        type="search"
        value={search.query}
        placeholder={t("Buscar en el documento")}
        aria-label={t("Buscar en el documento")}
        spellcheck="false"
        {oninput}
        {onkeydown}
      />
      <span class="status" aria-live="polite">{status}</span>
      <button
        class="icon"
        title={t("Anterior (Mayús Intro)")}
        aria-label={t("Resultado anterior")}
        disabled={search.matches.length === 0}
        onclick={() => search.previous()}
      >
        <ChevronUp size={16} />
      </button>
      <button
        class="icon"
        title={t("Siguiente (Intro)")}
        aria-label={t("Resultado siguiente")}
        disabled={search.matches.length === 0}
        onclick={() => search.next()}
      >
        <ChevronDown size={16} />
      </button>
      <button
        class="icon"
        class:on={replacing}
        title={t("Reemplazar o censurar")}
        aria-label={t("Reemplazar o censurar")}
        aria-expanded={replacing}
        onclick={() => (replacing = !replacing)}
      >
        <Replace size={16} />
      </button>
      <button class="icon" title={t("Cerrar (Esc)")} aria-label={t("Cerrar la búsqueda")} onclick={() => search.close()}>
        <X size={16} />
      </button>
    </div>
    {#if replacing}
      <div class="row replace">
        <input
          type="text"
          bind:value={replacement}
          placeholder={t("Reemplazar por")}
          aria-label={t("Reemplazar por")}
          spellcheck="false"
          onkeydown={onReplaceKeydown}
        />
        <button class="action" disabled={!canAct} onclick={replaceAll} title={t("Cambia el texto del documento en todas las páginas")}>
          <ReplaceAll size={15} />
          {t("Reemplazar todo")}
        </button>
        <button class="action" disabled={!canAct} onclick={redactAll} title={t("Tapa cada coincidencia con una zona censurada")}>
          <EyeOff size={15} />
          {t("Censurar todo")}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .search {
    position: absolute;
    top: 10px;
    right: 18px;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: min(460px, calc(100% - 36px));
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-md);
    color: var(--color-text-muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .replace {
    flex-wrap: wrap;
    padding-top: 4px;
    border-top: 1px solid var(--color-border);
  }
  .replace input {
    flex: 1 1 140px;
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 6px 4px;
    border: none;
    background: transparent;
    color: var(--color-text);
    outline: none;
  }
  .action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 9px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }
  .action:hover:not(:disabled) {
    background: var(--color-surface-muted);
  }
  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .icon.on {
    background: var(--color-surface-muted);
    color: var(--color-primary);
  }
  .status {
    flex-shrink: 0;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-icon);
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    background: var(--color-surface-muted);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
