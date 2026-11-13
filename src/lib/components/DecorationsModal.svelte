<script lang="ts">
  import { DEFAULT_DECORATIONS, type DecorationAlign, type NumberPosition, type PageDecorations } from "../decorations";
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import Modal from "./Modal.svelte";

  /** Working copy: the pages show it while the dialog is open, and it is kept only on "Apply". */
  let draft = $state<PageDecorations>(structuredClone($state.snapshot(editor.decorations) ?? DEFAULT_DECORATIONS));
  const previous = editor.decorations;
  let applied = false;

  const POSITIONS = $derived<{ value: NumberPosition; label: string }[]>([
    { value: "bottom-center", label: t("Abajo, en el centro") },
    { value: "bottom-right", label: t("Abajo, a la derecha") },
    { value: "bottom-left", label: t("Abajo, a la izquierda") },
    { value: "top-center", label: t("Arriba, en el centro") },
    { value: "top-right", label: t("Arriba, a la derecha") },
    { value: "top-left", label: t("Arriba, a la izquierda") },
  ]);
  const FORMATS = $derived([
    { value: "{n}", label: "1" },
    { value: "{n} / {N}", label: "1 / 10" },
    { value: t("Página {n}"), label: t("Página {n}", { n: 1 }) },
    { value: t("Página {n} de {N}"), label: t("Página {n} de {total}", { n: 1, total: 10 }) },
  ]);
  const ALIGNS = $derived<{ value: DecorationAlign; label: string }[]>([
    { value: "left", label: t("Izquierda") },
    { value: "center", label: t("Centro") },
    { value: "right", label: t("Derecha") },
  ]);

  // Live preview: the editor draws the draft over the pages.
  $effect(() => {
    const snapshot = $state.snapshot(draft) as PageDecorations;
    editor.decorations = snapshot;
  });

  function close() {
    if (!applied) editor.decorations = previous;
    editor.decorationsOpen = false;
  }

  function apply() {
    applied = true;
    editor.decorations = previous;
    editor.setDecorations($state.snapshot(draft) as PageDecorations);
    editor.decorationsOpen = false;
  }

  function removeAll() {
    applied = true;
    editor.decorations = previous;
    editor.setDecorations(null);
    editor.decorationsOpen = false;
  }
</script>

<Modal title={t("Numeración, encabezado y marca de agua")} onclose={close} wide>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      apply();
    }}
  >
    <p class="intro">
      {t("Se dibujan en cada página al exportar. Puedes usar {n} (número de página), {N} (total), {fecha} y {nombre}.")}
    </p>

    <fieldset>
      <legend>
        <label class="toggle">
          <input type="checkbox" bind:checked={draft.numbers.enabled} />
          {t("Números de página")}
        </label>
      </legend>
      <div class="grid" class:disabled={!draft.numbers.enabled}>
        <label class="field">
          <span>{t("Posición")}</span>
          <select bind:value={draft.numbers.position} disabled={!draft.numbers.enabled}>
            {#each POSITIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>{t("Formato")}</span>
          <select bind:value={draft.numbers.format} disabled={!draft.numbers.enabled}>
            {#each FORMATS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
            {#if !FORMATS.some((option) => option.value === draft.numbers.format)}
              <option value={draft.numbers.format}>{draft.numbers.format}</option>
            {/if}
          </select>
        </label>
        <label class="field">
          <span>{t("Empezar en el número")}</span>
          <input type="number" min="0" max="9999" bind:value={draft.numbers.startAt} disabled={!draft.numbers.enabled} />
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>{t("Encabezado y pie")}</legend>
      <div class="row">
        <label class="field grow">
          <span>{t("Encabezado")}</span>
          <input type="text" bind:value={draft.header.text} placeholder={t("Por ejemplo: {nombre} · Confidencial")} />
        </label>
        <label class="field">
          <span>{t("Alineación")}</span>
          <select bind:value={draft.header.align}>
            {#each ALIGNS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="row">
        <label class="field grow">
          <span>{t("Pie de página")}</span>
          <input type="text" bind:value={draft.footer.text} placeholder={t("Por ejemplo: Revisado el {fecha}")} />
        </label>
        <label class="field">
          <span>{t("Alineación")}</span>
          <select bind:value={draft.footer.align}>
            {#each ALIGNS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="grid">
        <label class="field">
          <span>{t("Desde la página")}</span>
          <input type="number" min="1" max={editor.pages.length} bind:value={draft.fromPage} />
        </label>
        <label class="field">
          <span>{t("Tamaño de letra")}</span>
          <input type="number" min="6" max="48" step="0.5" bind:value={draft.fontSize} />
        </label>
        <label class="field">
          <span>{t("Color")}</span>
          <input class="color" type="color" bind:value={draft.color} />
        </label>
        <label class="field">
          <span>{t("Margen (pt)")}</span>
          <input type="number" min="0" max="200" bind:value={draft.margin} />
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>{t("Marca de agua")}</legend>
      <div class="row">
        <label class="field grow">
          <span>{t("Texto")}</span>
          <input type="text" bind:value={draft.watermark.text} placeholder={t("Por ejemplo: BORRADOR")} />
        </label>
        <label class="field">
          <span>{t("Color")}</span>
          <input class="color" type="color" bind:value={draft.watermark.color} />
        </label>
      </div>
      <div class="row">
        <label class="field grow">
          <span>{t("Opacidad: {n} %", { n: Math.round(draft.watermark.opacity * 100) })}</span>
          <input type="range" min="0.05" max="1" step="0.05" bind:value={draft.watermark.opacity} />
        </label>
        <label class="toggle inline">
          <input type="checkbox" bind:checked={draft.watermark.diagonal} />
          {t("En diagonal")}
        </label>
      </div>
      <p class="note">{t("La marca de agua se pone en todas las páginas, por debajo de tus anotaciones.")}</p>
    </fieldset>

    <div class="actions">
      {#if previous}
        <button type="button" class="ghost danger" onclick={removeAll}>{t("Quitar todo")}</button>
      {/if}
      <button type="button" class="secondary" onclick={close}>{t("Cancelar")}</button>
      <button type="submit" class="primary">{t("Aplicar")}</button>
    </div>
  </form>
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .intro,
  .note {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    margin-bottom: 8px;
    padding: 0;
    font-weight: 600;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
  }
  .grid.disabled {
    opacity: 0.55;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
  }
  .field.grow {
    flex: 1;
  }
  input[type="text"],
  input[type="number"],
  select {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font: inherit;
    font-weight: 400;
  }
  .color {
    width: 48px;
    height: 34px;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: none;
  }
  input[type="range"] {
    accent-color: var(--color-primary);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .toggle.inline {
    padding-bottom: 6px;
    font-size: 13px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .ghost {
    margin-right: auto;
    background: transparent;
  }
  .ghost.danger {
    color: var(--color-danger);
  }
  .ghost.danger:hover {
    background: var(--color-danger-soft);
  }
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border) !important;
  }
  .primary {
    background: var(--color-primary);
    color: white;
  }
  @media (max-width: 560px) {
    .row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
