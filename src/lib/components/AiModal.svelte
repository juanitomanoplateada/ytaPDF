<script lang="ts">
  import { Copy, Download, Languages, Sparkles } from "lucide-svelte";
  import { downloadBytes } from "../deliver";
  import { editor } from "../editor.svelte";
  import { i18n, t } from "../i18n.svelte";
  import {
    abortable,
    aiSupport,
    detectLanguage,
    summarize,
    summarizerAvailability,
    SUMMARY_LANGUAGES,
    translate,
    translatorAvailability,
    TRANSLATION_LANGUAGES,
    type Availability,
    type SummaryOptions,
  } from "../localAi";
  import { notifications } from "../notifications.svelte";
  import Modal from "./Modal.svelte";

  type Task = "summary" | "translation";
  type Scope = "all" | "current" | "selection";

  const support = aiSupport();
  let task = $state<Task>("summary");
  let scope = $state<Scope>(editor.selectedText.trim() ? "selection" : "all");
  let summaryType = $state<SummaryOptions["type"]>("key-points");
  let summaryLength = $state<SummaryOptions["length"]>("medium");
  let summaryLanguage = $state(SUMMARY_LANGUAGES.includes(i18n.locale) ? i18n.locale : "en");
  let targetLanguage = $state(i18n.locale === "es" ? "en" : "es");
  let running = $state(false);
  let status = $state("");
  let progress = $state(0);
  let result = $state("");
  let availability = $state<Availability | null>(null);
  let controller: AbortController | null = null;

  const names = $derived(new Intl.DisplayNames([i18n.tag], { type: "language" }));
  const languageName = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const supported = $derived(task === "summary" ? support.summarize : support.translate);

  // What the model needs before it can run here (summaries; translation depends on the text's language).
  $effect(() => {
    const options = { type: summaryType, length: summaryLength, outputLanguage: summaryLanguage };
    if (task !== "summary" || !support.summarize) {
      availability = null;
      return;
    }
    let cancelled = false;
    void summarizerAvailability(options).then((value) => {
      if (!cancelled) availability = value;
    });
    return () => {
      cancelled = true;
    };
  });

  async function sourceText(): Promise<string> {
    if (scope === "selection") return editor.selectedText;
    return editor.documentText(scope === "current" ? [editor.currentPageId ?? editor.pages[0].id] : undefined);
  }

  function onProgress(event: { phase: "download" | "work"; progress: number }) {
    progress = event.progress;
    status = event.phase === "download" ? t("Chrome está descargando el modelo…") : t("Procesando…");
  }

  async function run(event: SubmitEvent) {
    event.preventDefault();
    if (running || !supported) return;
    running = true;
    result = "";
    progress = 0;
    status = t("Leyendo el texto…");
    controller = new AbortController();
    try {
      const text = (await sourceText()).trim();
      if (!text) {
        notifications.info(
          t("No hay texto que procesar. Si son páginas escaneadas, reconoce antes su texto con OCR."),
        );
        return;
      }
      const signal = controller.signal;
      if (task === "summary") {
        if ((await summarizerAvailability({ type: summaryType, length: summaryLength, outputLanguage: summaryLanguage })) === "unavailable") {
          notifications.error(t("Chrome no puede ejecutar el modelo de resúmenes en este dispositivo."));
          return;
        }
        result = await abortable(
          summarize(text, { type: summaryType, length: summaryLength, outputLanguage: summaryLanguage }, onProgress, signal),
          signal,
        );
      } else {
        status = t("Detectando el idioma…");
        const source = await abortable(detectLanguage(text, onProgress), signal);
        if (!source) {
          notifications.error(t("No se pudo saber en qué idioma está el texto."));
          return;
        }
        if (source.split("-")[0] === targetLanguage) {
          notifications.info(t("El texto ya está en {language}.", { language: languageName(targetLanguage) }));
          return;
        }
        const state = await translatorAvailability(source, targetLanguage);
        if (state === "unavailable") {
          notifications.error(
            t("Chrome no puede traducir de {from} a {to} en este dispositivo.", {
              from: languageName(source),
              to: languageName(targetLanguage),
            }),
          );
          return;
        }
        result = await abortable(translate(text, source, targetLanguage, onProgress, signal), signal);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("La IA del navegador no pudo completar la tarea:", error);
      notifications.error(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? t("Chrome necesita que pulses el botón otra vez para descargar el modelo.")
          : t("La IA del navegador no pudo completar la tarea en este dispositivo."),
      );
    } finally {
      running = false;
      controller = null;
      status = "";
    }
  }

  function close() {
    controller?.abort();
    editor.aiDialog = false;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(result);
      notifications.success(t("Texto copiado."));
    } catch {
      notifications.info(t("Selecciona el texto y cópialo con Ctrl C."));
    }
  }

  function download() {
    const suffix = task === "summary" ? t("resumen") : targetLanguage;
    downloadBytes(new TextEncoder().encode(result), `${editor.fileName} (${suffix}).txt`, "text/plain");
  }
</script>

<Modal title={t("IA en el dispositivo")} onclose={close} wide>
  <form onsubmit={run} novalidate>
    <div class="segmented" role="radiogroup" aria-label={t("Tarea")}>
      <button type="button" role="radio" aria-checked={task === "summary"} onclick={() => (task = "summary")}>
        <Sparkles size={16} /> {t("Resumir")}
      </button>
      <button type="button" role="radio" aria-checked={task === "translation"} onclick={() => (task = "translation")}>
        <Languages size={16} /> {t("Traducir")}
      </button>
    </div>

    <p class="note">
      {t(
        "Usa el modelo que Chrome ejecuta en tu equipo: el texto no sale del dispositivo. Disponible en Chrome 138 o posterior de escritorio, con hardware compatible.",
      )}
    </p>

    {#if !supported}
      <p class="warning" role="alert">
        {t("Este navegador no ofrece esta función de IA integrada. Prueba con Chrome de escritorio actualizado.")}
      </p>
    {:else}
      <fieldset disabled={running}>
        <legend>{t("Texto")}</legend>
        <div class="choices">
          <label><input type="radio" bind:group={scope} value="all" /> {t("Todo el documento")}</label>
          <label><input type="radio" bind:group={scope} value="current" /> {t("Página actual ({n})", { n: editor.currentPageIndex + 1 })}</label>
          <label>
            <input type="radio" bind:group={scope} value="selection" disabled={!editor.selectedText.trim()} />
            {t("Texto seleccionado")}
          </label>
        </div>
      </fieldset>

      {#if task === "summary"}
        <fieldset disabled={running}>
          <legend>{t("Resumen")}</legend>
          <div class="row">
            <label class="field">
              <span>{t("Forma")}</span>
              <select bind:value={summaryType}>
                <option value="key-points">{t("Puntos clave")}</option>
                <option value="tldr">{t("Resumen breve")}</option>
              </select>
            </label>
            <label class="field">
              <span>{t("Extensión")}</span>
              <select bind:value={summaryLength}>
                <option value="short">{t("Corta")}</option>
                <option value="medium">{t("Media")}</option>
                <option value="long">{t("Larga")}</option>
              </select>
            </label>
            <label class="field">
              <span>{t("Idioma")}</span>
              <select bind:value={summaryLanguage}>
                {#each SUMMARY_LANGUAGES as code (code)}
                  <option value={code}>{languageName(code)}</option>
                {/each}
              </select>
            </label>
          </div>
          {#if availability === "unavailable"}
            <p class="warning">{t("Chrome no puede ejecutar el modelo de resúmenes en este dispositivo.")}</p>
          {:else if availability === "downloadable" || availability === "downloading"}
            <p class="note">{t("La primera vez Chrome descargará el modelo, lo que puede tardar varios minutos.")}</p>
          {/if}
        </fieldset>
      {:else}
        <fieldset disabled={running}>
          <legend>{t("Traducción")}</legend>
          <label class="field narrow">
            <span>{t("Traducir al")}</span>
            <select bind:value={targetLanguage}>
              {#each TRANSLATION_LANGUAGES as code (code)}
                <option value={code}>{languageName(code)}</option>
              {/each}
            </select>
          </label>
          <p class="note">{t("El idioma del texto se detecta solo. La traducción se muestra aquí; el PDF no cambia.")}</p>
        </fieldset>
      {/if}

      {#if running}
        <div class="progress" role="status" aria-live="polite">
          <div class="bar"><div class="fill" style:width={`${Math.round(progress * 100)}%`}></div></div>
          <span>{status}</span>
        </div>
      {/if}

      {#if result}
        <div class="result">
          <textarea readonly rows="10" aria-label={t("Resultado")}>{result}</textarea>
          <div class="result-actions">
            <button type="button" class="secondary" onclick={copy}><Copy size={15} /> {t("Copiar")}</button>
            <button type="button" class="secondary" onclick={download}><Download size={15} /> {t("Descargar .txt")}</button>
          </div>
        </div>
      {/if}
    {/if}

    <div class="actions">
      <button type="button" class="secondary" onclick={close}>{running ? t("Detener") : t("Cerrar")}</button>
      {#if supported}
        <button type="submit" class="primary" disabled={running || (task === "summary" && availability === "unavailable")}>
          {#if task === "summary"}<Sparkles size={16} />{:else}<Languages size={16} />{/if}
          {running ? t("Procesando…") : task === "summary" ? t("Resumir") : t("Traducir")}
        </button>
      {/if}
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
  .segmented {
    display: flex;
    gap: 4px;
    width: fit-content;
    padding: 3px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-muted);
  }
  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .segmented button[aria-checked="true"] {
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
  }
  .note,
  .warning {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--color-text-muted);
  }
  .warning {
    color: var(--color-danger);
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
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .field {
    display: flex;
    flex: 1 1 140px;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
  }
  .field.narrow {
    max-width: 260px;
  }
  select,
  textarea {
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }
  textarea {
    width: 100%;
    min-height: 160px;
    resize: vertical;
    line-height: 1.5;
  }
  .result {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .result-actions {
    display: flex;
    gap: 8px;
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
  button.secondary,
  button.primary {
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
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
