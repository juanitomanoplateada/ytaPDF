<script lang="ts">
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import { chunkPages, describePages, parsePageRanges } from "../pageRanges";
  import Modal from "./Modal.svelte";

  let { onclose }: { onclose: () => void } = $props();

  type Mode = "ranges" | "every" | "single";

  const total = editor.pages.length;
  let mode = $state<Mode>("ranges");
  let ranges = $state(total > 1 ? `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}` : "1");
  let every = $state(Math.min(2, total));
  let fileName = $state(editor.fileName);
  let submitted = $state(false);

  const result = $derived.by((): { groups?: number[][]; error?: string } => {
    if (mode === "single") return { groups: chunkPages(total, 1) };
    if (mode === "every") {
      const size = Math.floor(Number(every));
      if (!Number.isFinite(size) || size < 1) return { error: t("Escribe cuántas páginas debe tener cada archivo.") };
      return { groups: chunkPages(total, size) };
    }
    const parsed = parsePageRanges(ranges, total);
    return parsed.groups ? parsed : { error: t(parsed.error, parsed.params) };
  });

  const preview = $derived(
    result.groups
      ? result.groups.length <= 8
        ? result.groups.map(describePages).join(" · ")
        : `${result.groups.slice(0, 6).map(describePages).join(" · ")} · … · ${describePages(result.groups.at(-1)!)}`
      : "",
  );
  const working = $derived(editor.busy !== null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    if (!result.groups || working) return;
    if (await editor.splitDocument(result.groups, fileName)) onclose();
  }
</script>

<Modal title={t("Dividir el documento")} {onclose} wide>
  <form onsubmit={submit} novalidate>
    <p class="intro">{t("Crea varios PDF a partir de este documento, en el orden actual de las páginas.")}</p>

    <fieldset>
      <legend>{t("Cómo dividirlo")}</legend>
      <label class="option">
        <input type="radio" bind:group={mode} value="ranges" />
        <span>
          <strong>{t("Por rangos")}</strong>
          <small>{t("Cada rango separado por comas es un archivo.")}</small>
          <input
            type="text"
            bind:value={ranges}
            placeholder="1-3, 4-6, 7-"
            aria-label={t("Rangos de páginas")}
            onfocus={() => (mode = "ranges")}
            aria-invalid={mode === "ranges" && !!result.error}
          />
        </span>
      </label>
      <label class="option">
        <input type="radio" bind:group={mode} value="every" />
        <span>
          <strong>{t("Cada cierto número de páginas")}</strong>
          <span class="inline">
            {t("Archivos de")}
            <input
              class="number"
              type="number"
              min="1"
              max={total}
              bind:value={every}
              aria-label={t("Páginas por archivo")}
              onfocus={() => (mode = "every")}
            />
            {t("páginas")}
          </span>
        </span>
      </label>
      <label class="option">
        <input type="radio" bind:group={mode} value="single" />
        <span>
          <strong>{t("Una página por archivo")}</strong>
          <small>{total === 1 ? t("1 archivo") : t("{n} archivos", { n: total })}</small>
        </span>
      </label>
    </fieldset>

    <label class="field">
      <span>{t("Nombre base de los archivos")}</span>
      <input type="text" bind:value={fileName} maxlength="160" spellcheck="false" />
    </label>

    {#if result.error}
      <p class="error" role="alert">{result.error}</p>
    {:else if result.groups}
      <p class="summary">
        <strong>
          {result.groups.length === 1
            ? t("Se creará 1 archivo:")
            : t("Se crearán {n} archivos en un ZIP:", { n: result.groups.length })}
        </strong>
        {t("páginas {list}", { list: preview })}
      </p>
    {/if}

    <div class="actions">
      <button type="button" class="secondary" onclick={onclose}>{t("Cancelar")}</button>
      <button type="submit" class="primary" disabled={working || (submitted && !result.groups)}>
        {working ? t("Dividiendo…") : t("Dividir y descargar")}
      </button>
    </div>
  </form>
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .intro {
    margin: 0;
    color: var(--color-text-muted);
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    margin-bottom: 8px;
    padding: 0;
    font-weight: 600;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
  }
  .option > input {
    margin-top: 4px;
  }
  .option > span {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
  }
  .option strong {
    font-weight: 500;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--color-text-muted);
  }
  small {
    color: var(--color-text-muted);
    font-size: 12.5px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
  }
  input[type="text"],
  input[type="number"] {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font: inherit;
  }
  input[aria-invalid="true"] {
    border-color: var(--color-danger);
  }
  .number {
    width: 72px;
  }
  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: 13px;
  }
  .summary {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--color-primary-soft);
    color: var(--color-text);
    font-size: 13px;
    overflow-wrap: anywhere;
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
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border) !important;
  }
  .primary {
    background: var(--color-primary);
    color: white;
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
