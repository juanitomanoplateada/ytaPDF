<script lang="ts">
  import { onMount } from "svelte";
  import { Eye, EyeOff, FileImage, FileKey, FileText, Lock, Printer, Share2, Shrink } from "lucide-svelte";
  import type { CompressionLevel } from "../compression";
  import { canPickSaveLocation, canShareFiles } from "../deliver";
  import { editor } from "../editor.svelte";
  import { formatDate, t } from "../i18n.svelte";
  import type { CertificateSummary } from "../export/sign";
  import type { DocumentMetadata } from "../export";
  import { parsePageRanges } from "../pageRanges";
  import Modal from "./Modal.svelte";

  type Format = "pdf" | "png" | "jpeg";
  type Scope = "all" | "current" | "range";

  const RESOLUTIONS = $derived([
    { dpi: 72, label: t("{n} ppp", { n: 72 }), hint: t("pantalla") },
    { dpi: 150, label: t("{n} ppp", { n: 150 }), hint: t("estándar") },
    { dpi: 300, label: t("{n} ppp", { n: 300 }), hint: t("impresión") },
  ]);
  const COMPRESSION_LEVELS = $derived<{ value: CompressionLevel; label: string; hint: string }[]>([
    { value: "light", label: t("Ligera"), hint: t("casi sin pérdida visible") },
    { value: "balanced", label: t("Equilibrada"), hint: t("recomendada") },
    { value: "strong", label: t("Máxima"), hint: t("para enviar por correo") },
  ]);
  const METADATA_FIELDS = $derived<{ key: keyof DocumentMetadata; label: string }[]>([
    { key: "title", label: t("Título") },
    { key: "author", label: t("Autor") },
    { key: "subject", label: t("Asunto") },
    { key: "keywords", label: t("Palabras clave") },
  ]);

  let format = $state<Format>(editor.exportDialog === "image" ? "png" : "pdf");
  let fileName = $state(editor.fileName);
  let scope = $state<Scope>("all");
  let range = $state("");
  let protect = $state(false);
  let password = $state("");
  let repeat = $state("");
  let reveal = $state(false);
  let flatten = $state(false);
  let sign = $state(false);
  let certificate = $state<{ name: string; bytes: Uint8Array } | null>(null);
  let certificatePassword = $state("");
  let reason = $state("");
  let place = $state("");
  let certificateCheck = $state<{ summary: CertificateSummary } | { error: string } | null>(null);
  let checking = $state(false);
  let compress = $state(false);
  let compressionLevel = $state<CompressionLevel>("balanced");
  let hasForms = $state(false);
  let dpi = $state(150);
  let metadata = $state<DocumentMetadata>({ title: "", author: "", subject: "", keywords: "" });
  let original: DocumentMetadata | null = null;
  let strip = $state(editor.stripMetadata);
  let submitted = $state(false);

  const isPdf = $derived(format === "pdf");
  const working = $derived(editor.busy !== null);

  onMount(() => {
    void editor.documentMetadata().then((value) => (metadata = value));
    void editor.documentMetadata(true).then((value) => (original = value));
    void editor.hasFormFields().then((value) => (hasForms = value));
  });

  const pages = $derived.by((): { ids?: string[]; error?: string } => {
    if (scope === "all") return { ids: editor.pages.map((page) => page.id) };
    if (scope === "current") return { ids: [editor.currentPageId ?? editor.pages[0].id] };
    const parsed = parsePageRanges(range, editor.pages.length);
    if (!parsed.groups) return { error: t(parsed.error, parsed.params) };
    const indices = new Set(parsed.groups.flat());
    return { ids: editor.pages.filter((_, i) => indices.has(i)).map((page) => page.id) };
  });

  const passwordError = $derived(
    !isPdf || !protect || sign
      ? null
      : password.length === 0
        ? t("Escribe la contraseña.")
        : password !== repeat
          ? t("Las dos contraseñas no coinciden.")
          : null,
  );
  const signatureError = $derived(
    !isPdf || !sign
      ? null
      : !certificate
        ? t("Elige el archivo del certificado.")
        : certificateCheck && "error" in certificateCheck
          ? certificateCheck.error
          : !certificateCheck
            ? t("Escribe la contraseña del certificado y pulsa «Comprobar».")
            : null,
  );
  const valid = $derived(!pages.error && !passwordError && !signatureError && (pages.ids?.length ?? 0) > 0);

  async function chooseCertificate(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    certificate = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    certificateCheck = null;
    if (certificatePassword) await checkCertificate();
  }

  async function checkCertificate() {
    if (!certificate || checking) return;
    checking = true;
    try {
      certificateCheck = await editor.checkCertificate(certificate.bytes, certificatePassword);
    } finally {
      checking = false;
    }
  }
  const pageCount = $derived(pages.ids?.length ?? 0);
  const selectedIds = $derived(scope === "all" ? undefined : pages.ids);

  function close() {
    editor.exportDialog = null;
  }

  /** Keeps the edited properties for this and later exports (null when unchanged). */
  function keepMetadata() {
    const changed = original === null || METADATA_FIELDS.some(({ key }) => metadata[key].trim() !== original![key].trim());
    editor.setMetadata(changed ? { ...metadata } : null, strip);
  }

  function pdfOptions() {
    return {
      fileName,
      pageIds: selectedIds,
      password: protect && !sign ? password : undefined,
      flattenForms: hasForms && flatten,
      compression: compress ? compressionLevel : undefined,
      signature:
        sign && certificate
          ? { certificate: certificate.bytes, password: certificatePassword, reason: reason.trim(), location: place.trim() }
          : undefined,
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    if (!valid || working) return;
    if (isPdf) {
      keepMetadata();
      if (await editor.saveAs(pdfOptions())) close();
    } else {
      editor.setFileName(fileName);
      const done = await editor.exportImages({
        pageIds: pages.ids ?? [],
        format: format === "png" ? "image/png" : "image/jpeg",
        dpi,
        fileName,
      });
      if (done) close();
    }
  }

  function share() {
    submitted = true;
    if (!valid || working) return;
    keepMetadata();
    const options = pdfOptions();
    close();
    void editor.shareDocument(options);
  }

  function print() {
    submitted = true;
    if (pages.error || working) return;
    const ids = selectedIds;
    close();
    void editor.printDocument(ids);
  }
</script>

<Modal title={isPdf ? t("Guardar como") : t("Exportar como imagen")} onclose={close} wide>
  <form onsubmit={submit} novalidate>
    <div class="segmented" role="radiogroup" aria-label={t("Formato")}>
      <button type="button" role="radio" aria-checked={format === "pdf"} onclick={() => (format = "pdf")}>
        <FileText size={16} /> PDF
      </button>
      <button type="button" role="radio" aria-checked={format === "png"} onclick={() => (format = "png")}>
        <FileImage size={16} /> PNG
      </button>
      <button type="button" role="radio" aria-checked={format === "jpeg"} onclick={() => (format = "jpeg")}>
        <FileImage size={16} /> JPG
      </button>
    </div>

    <label class="field">
      <span>{t("Nombre del archivo")}</span>
      <div class="with-suffix">
        <input type="text" bind:value={fileName} maxlength="180" spellcheck="false" data-autofocus />
        <span class="suffix">{isPdf ? ".pdf" : pageCount > 1 ? ".zip" : format === "png" ? ".png" : ".jpg"}</span>
      </div>
    </label>

    <fieldset>
      <legend>{t("Páginas")}</legend>
      <div class="choices">
        <label><input type="radio" bind:group={scope} value="all" /> {t("Todas ({n})", { n: editor.pages.length })}</label>
        <label><input type="radio" bind:group={scope} value="current" /> {t("Página actual ({n})", { n: editor.currentPageIndex + 1 })}</label>
        <label class="range-choice">
          <input type="radio" bind:group={scope} value="range" />
          {t("Rango")}
          <input
            class="range"
            type="text"
            placeholder="1-3, 5, 8-"
            aria-label={t("Rango de páginas")}
            bind:value={range}
            onfocus={() => (scope = "range")}
            aria-invalid={scope === "range" && submitted && !!pages.error}
          />
        </label>
      </div>
      {#if scope === "range" && pages.error && (submitted || range.trim())}
        <p class="error" role="alert">{pages.error}</p>
      {/if}
    </fieldset>

    {#if isPdf}
      <fieldset>
        <legend>{t("Seguridad")}</legend>
        <label class="check">
          <input type="checkbox" bind:checked={protect} disabled={sign} />
          <span>
            <strong><Lock size={14} /> {t("Proteger con contraseña")}</strong>
            <small>{t("Cifrado AES-256: sin la contraseña no se puede abrir. ytaPDF no la guarda, así que no la olvides.")}</small>
          </span>
        </label>
        {#if protect && !sign}
          <div class="passwords">
            <label class="field">
              <span>{t("Contraseña")}</span>
              <div class="with-suffix">
                <input type={reveal ? "text" : "password"} autocomplete="new-password" bind:value={password} />
                <button
                  type="button"
                  class="reveal"
                  aria-label={reveal ? t("Ocultar la contraseña") : t("Mostrar la contraseña")}
                  title={reveal ? t("Ocultar") : t("Mostrar")}
                  onclick={() => (reveal = !reveal)}
                >
                  {#if reveal}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
                </button>
              </div>
            </label>
            <label class="field">
              <span>{t("Repite la contraseña")}</span>
              <input type={reveal ? "text" : "password"} autocomplete="new-password" bind:value={repeat} />
            </label>
          </div>
          {#if passwordError && (submitted || repeat.length > 0)}
            <p class="error" role="alert">{passwordError}</p>
          {/if}
        {/if}
        <label class="check">
          <input type="checkbox" bind:checked={sign} />
          <span>
            <strong><FileKey size={14} /> {t("Firmar digitalmente con un certificado")}</strong>
            <small>
              {t("Firma electrónica con tu certificado (.p12 o .pfx). Cualquier cambio posterior la invalida. No se puede combinar con la contraseña.")}
            </small>
          </span>
        </label>
        {#if sign}
          <div class="signature">
            <label class="file-choice">
              <input type="file" accept=".p12,.pfx,application/x-pkcs12" onchange={chooseCertificate} hidden />
              <span class="file-button">{certificate ? t("Cambiar certificado") : t("Elegir certificado…")}</span>
              <span class="file-name">{certificate?.name ?? t("Ningún archivo elegido")}</span>
            </label>
            <div class="passwords">
              <label class="field">
                <span>{t("Contraseña del certificado")}</span>
                <div class="with-suffix">
                  <input
                    type="password"
                    autocomplete="off"
                    bind:value={certificatePassword}
                    oninput={() => (certificateCheck = null)}
                    onkeydown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void checkCertificate();
                      }
                    }}
                  />
                </div>
              </label>
              <button type="button" class="check-button" disabled={!certificate || checking} onclick={checkCertificate}>
                {checking ? t("Comprobando…") : t("Comprobar")}
              </button>
            </div>
            {#if certificateCheck && "summary" in certificateCheck}
              <p class="certificate-ok">
                {t("Firmará {name}, emitido por {issuer}, válido hasta el {date}.", {
                  name: certificateCheck.summary.name,
                  issuer: certificateCheck.summary.issuer,
                  date: formatDate(certificateCheck.summary.validTo, { day: "numeric", month: "long", year: "numeric" }),
                })}
                {#if certificateCheck.summary.validTo.getTime() < Date.now()}
                  <strong>{t("El certificado está caducado: los lectores mostrarán la firma como no válida.")}</strong>
                {/if}
              </p>
            {/if}
            <div class="passwords">
              <label class="field">
                <span>{t("Motivo (opcional)")}</span>
                <input type="text" bind:value={reason} maxlength="200" placeholder={t("Conforme")} />
              </label>
              <label class="field">
                <span>{t("Lugar (opcional)")}</span>
                <input type="text" bind:value={place} maxlength="200" />
              </label>
            </div>
            {#if signatureError && submitted}
              <p class="error" role="alert">{signatureError}</p>
            {/if}
          </div>
        {/if}
        {#if hasForms}
          <label class="check">
            <input type="checkbox" bind:checked={flatten} />
            <span>
              <strong>{t("Aplanar los formularios")}</strong>
              <small>{t("Los campos quedan fijos en la página con lo que tengan escrito y ya no se pueden cambiar.")}</small>
            </span>
          </label>
        {/if}
      </fieldset>

      <fieldset>
        <legend>{t("Tamaño del archivo")}</legend>
        <label class="check">
          <input type="checkbox" bind:checked={compress} />
          <span>
            <strong><Shrink size={14} /> {t("Reducir el tamaño")}</strong>
            <small>{t("Recomprime las fotos JPEG del documento y baja su resolución cuando es mayor de la necesaria. El texto y los dibujos no cambian.")}</small>
          </span>
        </label>
        {#if compress}
          <div class="choices indent" role="radiogroup" aria-label={t("Nivel de compresión")}>
            {#each COMPRESSION_LEVELS as option (option.value)}
              <label>
                <input type="radio" bind:group={compressionLevel} value={option.value} />
                {option.label} <span class="muted">({option.hint})</span>
              </label>
            {/each}
          </div>
        {/if}
      </fieldset>

      <details>
        <summary>{t("Propiedades del documento")}</summary>
        <label class="check">
          <input type="checkbox" bind:checked={strip} />
          <span>
            <strong>{t("Quitar todos los metadatos")}</strong>
            <small>{t("Borra título, autor, fechas y el programa con el que se creó. Útil antes de compartirlo.")}</small>
          </span>
        </label>
        <div class="metadata">
          {#each METADATA_FIELDS as field (field.key)}
            <label class="field">
              <span>{field.label}</span>
              <input type="text" bind:value={metadata[field.key]} disabled={strip} maxlength="500" />
            </label>
          {/each}
        </div>
        <p class="note">{t("Los cambios se aplican a este y a los próximos archivos que exportes.")}</p>
      </details>
    {:else}
      <fieldset>
        <legend>{t("Resolución")}</legend>
        <div class="choices">
          {#each RESOLUTIONS as option (option.dpi)}
            <label>
              <input type="radio" bind:group={dpi} value={option.dpi} />
              {option.label} <span class="muted">({option.hint})</span>
            </label>
          {/each}
        </div>
        <p class="note">
          {pageCount > 1
            ? t("Se descargará un archivo ZIP con {n} imágenes, una por página.", { n: pageCount })
            : t("Se descargará una imagen de la página.")}
          {format === "jpeg" ? t("JPG ocupa menos; PNG conserva mejor el texto y las líneas finas.") : ""}
        </p>
      </fieldset>
    {/if}

    <div class="actions">
      {#if isPdf}
        <div class="secondary-actions">
          <button type="button" class="ghost" onclick={print} disabled={working} title={t("Imprimir las páginas elegidas")}>
            <Printer size={16} /> {t("Imprimir")}
          </button>
          {#if canShareFiles}
            <button type="button" class="ghost" onclick={share} disabled={working}>
              <Share2 size={16} /> {t("Compartir")}
            </button>
          {/if}
        </div>
      {/if}
      <button type="button" class="secondary" onclick={close}>{t("Cancelar")}</button>
      <button type="submit" class="primary" disabled={working || (submitted && !valid)}>
        {working ? t("Generando…") : isPdf ? (canPickSaveLocation ? t("Guardar…") : t("Descargar")) : t("Exportar")}
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
  .field {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    font-weight: 500;
  }
  input[type="text"],
  input[type="password"] {
    width: 100%;
    min-width: 0;
    padding: 9px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font: inherit;
  }
  input:disabled {
    background: var(--color-surface-muted);
    color: var(--color-text-muted);
  }
  input[aria-invalid="true"] {
    border-color: var(--color-danger);
  }
  .with-suffix {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .suffix {
    color: var(--color-text-muted);
    font-weight: 400;
  }
  .reveal {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text-muted);
    cursor: pointer;
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
  .range-choice .range {
    width: 130px;
    padding: 5px 8px;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
  }
  .check input {
    margin-top: 3px;
  }
  .check span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .check strong {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  small,
  .note,
  .muted {
    color: var(--color-text-muted);
    font-size: 12.5px;
  }
  .note {
    margin: 0;
  }
  .passwords {
    display: flex;
    gap: 12px;
    padding-left: 26px;
  }
  .error {
    margin: 0;
    color: var(--color-danger);
    font-size: 13px;
  }
  details {
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  summary {
    font-weight: 600;
    cursor: pointer;
  }
  details[open] summary {
    margin-bottom: 12px;
  }
  .metadata {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
    margin: 12px 0 8px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .secondary-actions {
    display: flex;
    gap: 4px;
    margin-right: auto;
  }
  .signature {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-left: 26px;
  }
  .indent {
    padding-left: 26px;
  }
  .signature .passwords {
    padding-left: 0;
  }
  .file-choice {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    cursor: pointer;
  }
  .file-button,
  .check-button {
    flex-shrink: 0;
    padding: 7px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-muted);
    color: var(--color-text);
    font: inherit;
    font-size: 13.5px;
    cursor: pointer;
  }
  .check-button {
    align-self: flex-end;
  }
  .check-button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .file-name {
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .certificate-ok {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 13px;
    line-height: 1.45;
  }
  .certificate-ok strong {
    display: block;
    color: var(--color-danger);
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
  .ghost {
    background: transparent;
    color: var(--color-primary);
  }
  .ghost:hover:not(:disabled) {
    background: var(--color-primary-soft);
  }
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border) !important;
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
  @media (max-width: 560px) {
    .passwords,
    .metadata {
      display: flex;
      flex-direction: column;
      padding-left: 0;
    }
  }
</style>
