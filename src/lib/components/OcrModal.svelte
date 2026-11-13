<script lang="ts">
  import { ScanText } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { i18n, t } from "../i18n.svelte";
  import { OCR_LANGUAGES, type OcrLanguage } from "../ocr";
  import Modal from "./Modal.svelte";

  type Scope = "untexted" | "current" | "all";

  let scope = $state<Scope>("untexted");
  let languages = $state<OcrLanguage[]>(i18n.locale === "es" ? ["spa"] : ["eng"]);
  let running = $state(false);
  let progress = $state({ page: 0, total: 0, fraction: 0, loading: true });
  let controller: AbortController | null = null;

  const percent = $derived(
    progress.total === 0 ? 0 : Math.round(((progress.page - 1 + progress.fraction) / progress.total) * 100),
  );

  function close() {
    if (running) controller?.abort();
    editor.ocrDialog = false;
  }

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (running || languages.length === 0) return;
    running = true;
    controller = new AbortController();
    try {
      const pages = scope === "current" ? [editor.currentPageId ?? editor.pages[0].id] : editor.pages.map((page) => page.id);
      const done = await editor.recognizeText(pages, [...languages], {
        onlyWithoutText: scope === "untexted",
        signal: controller.signal,
        onProgress: (value) => (progress = value),
      });
      if (done) editor.ocrDialog = false;
    } finally {
      running = false;
      controller = null;
    }
  }
</script>

<Modal title={t("Reconocer texto (OCR)")} onclose={close}>
  <form onsubmit={start} novalidate>
    <p class="intro">
      {t(
        "Convierte el texto de las páginas escaneadas en texto que se puede buscar, seleccionar, copiar y censurar. Se hace en este dispositivo: el documento no sale de él.",
      )}
    </p>

    <fieldset disabled={running}>
      <legend>{t("Páginas")}</legend>
      <div class="choices">
        <label><input type="radio" bind:group={scope} value="untexted" /> {t("Las que no tienen texto")}</label>
        <label><input type="radio" bind:group={scope} value="current" /> {t("Página actual ({n})", { n: editor.currentPageIndex + 1 })}</label>
        <label><input type="radio" bind:group={scope} value="all" /> {t("Todas ({n})", { n: editor.pages.length })}</label>
      </div>
    </fieldset>

    <fieldset disabled={running}>
      <legend>{t("Idioma del documento")}</legend>
      <div class="choices">
        {#each OCR_LANGUAGES as language (language.code)}
          <label><input type="checkbox" bind:group={languages} value={language.code} /> {language.label}</label>
        {/each}
      </div>
      {#if languages.length === 0}
        <p class="error" role="alert">{t("Elige al menos un idioma.")}</p>
      {/if}
    </fieldset>

    {#if running}
      <div class="progress" role="status" aria-live="polite">
        <div class="bar"><div class="fill" style:width={`${percent}%`}></div></div>
        <span>
          {progress.total === 0
            ? t("Preparando…")
            : progress.loading
              ? t("Cargando el motor de reconocimiento…")
              : t("Página {n} de {total}…", { n: progress.page, total: progress.total })}
        </span>
      </div>
    {:else}
      <p class="note">{t("La primera vez se descargan unos 6 MB (el motor y los idiomas) desde este mismo sitio.")}</p>
    {/if}

    <div class="actions">
      <button type="button" class="secondary" onclick={close}>{running ? t("Detener") : t("Cancelar")}</button>
      <button type="submit" class="primary" disabled={running || languages.length === 0}>
        <ScanText size={16} />
        {running ? t("Reconociendo…") : t("Reconocer")}
      </button>
    </div>
  </form>
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 8px;
  }
  .intro,
  .note {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 13.5px;
    line-height: 1.45;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    margin-bottom: 8px;
    font-weight: 600;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
  }
  .choices label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .error {
    margin: 8px 0 0;
    color: var(--color-danger);
    font-size: 13px;
  }
  .progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .bar {
    height: 8px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--color-surface-muted);
  }
  .fill {
    height: 100%;
    background: var(--color-primary);
    transition: width 0.2s ease;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border) !important;
    color: var(--color-text);
  }
  .primary {
    background: var(--color-primary);
    color: white;
  }
  .primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .actions button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
