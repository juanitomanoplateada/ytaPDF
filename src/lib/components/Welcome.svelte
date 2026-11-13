<script lang="ts">
  import {
    ChevronDown,
    FilePlus,
    FolderOpen,
    History,
    Images,
    LayoutGrid,
    Lock,
    MonitorDown,
    Plus,
    ShieldCheck,
    Signature,
    SquareCheck,
    TextCursorInput,
    Trash2,
    Type,
    Upload,
  } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { formatDate, pagesLabel, t } from "../i18n.svelte";
  import { PROJECT_EXTENSION } from "../project";
  import { pwa } from "../pwa.svelte";
  import Menu from "./Menu.svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();

  const PAPER_SIZES = $derived([
    { label: t("A4 vertical"), width: 595.28, height: 841.89 },
    { label: t("A4 horizontal"), width: 841.89, height: 595.28 },
    { label: t("Carta vertical"), width: 612, height: 792 },
    { label: t("Carta horizontal"), width: 792, height: 612 },
    { label: t("Oficio vertical"), width: 612, height: 1008 },
  ]);

  let imageInput: HTMLInputElement;
  let projectInput: HTMLInputElement;

  function takeFiles(event: Event): File[] {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    return files;
  }

  const when = (savedAt: number) => formatDate(savedAt, { dateStyle: "medium", timeStyle: "short" });
</script>

<div class="welcome">
  <div class="card">
    {#if editor.savedWorks.length > 0}
      <section class="works" aria-label={t("Trabajos guardados en este navegador")}>
        <h2><History size={18} /> {t("Trabajos guardados en este navegador")}</h2>
        <ul>
          {#each editor.savedWorks as work (work.id)}
            <li>
              <button class="open-work" onclick={() => void editor.openWork(work.id)} title={t("Abrir")}>
                <strong>{work.documentName}</strong>
                <span>
                  {pagesLabel(work.pageCount)} · {when(work.savedAt)}
                  {#if !work.kept}<em class="badge">{t("Sin terminar")}</em>{/if}
                </span>
              </button>
              <button
                class="delete-work"
                title={t("Eliminar del navegador")}
                aria-label={t("Eliminar «{name}» del navegador", { name: work.documentName })}
                onclick={() => void editor.deleteWork(work.id)}
              >
                <Trash2 size={16} />
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <img src="/paty.png" alt="" class="logo" />
    <h1>{t("Bienvenido a")} <span class="yta">yta</span><span class="pdf">PDF</span></h1>
    <p class="subtitle">{t("La herramienta web rápida y privada para gestionar tus documentos.")}</p>

    <ul class="features">
      <li><Plus size={20} /> {t("Unir varios PDF")}</li>
      <li><LayoutGrid size={20} /> {t("Reorganizar y girar páginas")}</li>
      <li><TextCursorInput size={20} /> {t("Editar el texto del PDF")}</li>
      <li><Type size={20} /> {t("Texto, imágenes y formas")}</li>
      <li><Signature size={20} /> {t("Firmar documentos")}</li>
      <li><SquareCheck size={20} /> {t("Rellenar formularios")}</li>
      <li><ShieldCheck size={20} /> {t("Censurar información")}</li>
      <li><Lock size={20} /> {t("Proteger con contraseña")}</li>
    </ul>

    <button class="upload" onclick={onopenfiles}>
      <Upload size={18} />
      {t("Cargar PDF")}
    </button>
    <p class="drop-hint">{t("o arrastra tus archivos a esta ventana (las imágenes se convierten en PDF)")}</p>

    <div class="start">
      <span class="start-label">{t("Sin PDF:")}</span>
      <Menu label={t("Documento en blanco")} triggerClass="start-button">
        {#snippet trigger()}
          <FilePlus size={16} />
          {t("Documento en blanco")}
          <ChevronDown size={14} />
        {/snippet}
        {#snippet children(close)}
          {#each PAPER_SIZES as size (size.width + "x" + size.height)}
            <button
              role="menuitem"
              onclick={() => {
                close();
                void editor.createBlankDocument(size.width, size.height);
              }}
            >
              {size.label}
            </button>
          {/each}
        {/snippet}
      </Menu>
      <button class="start-button" onclick={() => imageInput.click()}>
        <Images size={16} />
        {t("Imágenes a PDF")}
      </button>
      <button class="start-button" onclick={() => projectInput.click()}>
        <FolderOpen size={16} />
        {t("Abrir proyecto")}
      </button>
      <input
        bind:this={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onchange={(event) => void editor.addImagePages(takeFiles(event))}
      />
      <input
        bind:this={projectInput}
        type="file"
        accept={PROJECT_EXTENSION}
        hidden
        onchange={(event) => {
          const [file] = takeFiles(event);
          if (file) void editor.openProject(file);
        }}
      />
    </div>

    <p class="privacy">
      <ShieldCheck size={16} />
      {t("Tus archivos se procesan en este navegador y nunca se envían a ningún servidor.")}
    </p>
    {#if pwa.canInstall}
      <button class="install" onclick={() => void pwa.install()}>
        <MonitorDown size={16} />
        {t("Instalar ytaPDF para usarlo sin conexión")}
      </button>
    {/if}
  </div>
</div>

<style>
  .welcome {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 24px 16px;
    overflow-y: auto;
    background: var(--color-surface-muted);
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(600px, 100%);
    padding: 48px 40px 32px;
    border: 1px dashed var(--color-border-dashed);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-md);
    text-align: center;
  }
  .logo {
    width: 140px;
    height: auto;
    margin-bottom: 20px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
    font-weight: 600;
  }
  .yta {
    color: var(--color-heading);
  }
  .pdf {
    color: var(--color-primary);
  }
  .subtitle {
    margin: 0 0 28px;
    color: var(--color-text-muted);
    font-size: 15px;
  }
  .features {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    width: 100%;
    margin: 0 0 28px;
    padding: 22px 24px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel);
    list-style: none;
    text-align: left;
  }
  .features li {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    font-weight: 500;
    color: var(--color-heading);
  }
  .features :global(svg) {
    color: var(--color-primary);
    flex-shrink: 0;
  }
  .upload {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 13px 30px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-primary);
    color: white;
    font-size: 16px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .upload:hover {
    background: var(--color-primary-hover);
  }
  .drop-hint {
    margin: 10px 0 0;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .start {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 18px;
  }
  .start-label {
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .start :global(.start-button) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .start :global(.start-button:hover) {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .privacy {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 28px 0 0;
    padding-top: 20px;
    border-top: 1px solid var(--color-border);
    width: 100%;
    color: var(--color-success);
    font-size: 13px;
  }
  .privacy :global(svg) {
    flex-shrink: 0;
  }
  .install {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    padding: 8px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: 13px;
    cursor: pointer;
  }
  .install:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .works {
    width: 100%;
    margin-bottom: 28px;
    padding: 14px 16px;
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    text-align: left;
  }
  .works h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    color: var(--color-primary);
    font-size: 14px;
    font-weight: 600;
  }
  .works ul {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 220px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .works li {
    display: flex;
    gap: 6px;
  }
  .open-work {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 8px 12px;
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    text-align: left;
    cursor: pointer;
  }
  .open-work:hover {
    border-color: var(--color-primary);
  }
  .open-work strong {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open-work span {
    color: var(--color-text-muted);
    font-size: 12.5px;
  }
  .badge {
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-surface-muted);
    color: var(--color-warning);
    font-size: 11.5px;
    font-style: normal;
    font-weight: 600;
  }
  .delete-work {
    display: grid;
    place-items: center;
    width: 38px;
    border: 1px solid var(--color-primary-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-danger);
    cursor: pointer;
  }
  .delete-work:hover {
    background: var(--color-danger-soft);
  }

  @media (max-width: 600px) {
    .card {
      padding: 32px 20px 24px;
    }
    .features {
      grid-template-columns: 1fr;
    }
    h1 {
      font-size: 24px;
    }
  }
</style>
