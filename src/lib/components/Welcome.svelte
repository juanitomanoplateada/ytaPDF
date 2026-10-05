<script lang="ts">
  import {
    History,
    LayoutGrid,
    MonitorDown,
    Plus,
    ShieldCheck,
    Signature,
    SquareCheck,
    Type,
    Upload,
  } from "lucide-svelte";
  import { editor } from "../editor.svelte";
  import { pwa } from "../pwa.svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();

  const savedAt = $derived(
    editor.recovery
      ? new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(editor.recovery.savedAt)
      : "",
  );
</script>

<div class="welcome">
  <div class="card">
    {#if editor.recovery}
      <div class="recovery" role="region" aria-label="Trabajo sin terminar">
        <History size={20} />
        <div class="recovery-text">
          <strong>Tienes un trabajo sin terminar</strong>
          <span>
            «{editor.recovery.documentName}», {editor.recovery.pageCount === 1 ? "1 página" : `${editor.recovery.pageCount} páginas`}
            · guardado el {savedAt}
          </span>
        </div>
        <div class="recovery-actions">
          <button class="restore" onclick={() => void editor.restoreSession()}>Recuperar</button>
          <button class="discard" onclick={() => void editor.discardRecovery()}>Descartar</button>
        </div>
      </div>
    {/if}

    <img src="/paty.png" alt="" class="logo" />
    <h1>Bienvenido a <span class="yta">yta</span><span class="pdf">PDF</span></h1>
    <p class="subtitle">La herramienta web rápida y privada para gestionar tus documentos.</p>

    <ul class="features">
      <li><Plus size={20} /> Unir varios PDF</li>
      <li><LayoutGrid size={20} /> Reorganizar y girar páginas</li>
      <li><Type size={20} /> Texto, imágenes y formas</li>
      <li><Signature size={20} /> Firmar documentos</li>
      <li><SquareCheck size={20} /> Rellenar formularios</li>
      <li><ShieldCheck size={20} /> Censurar información</li>
    </ul>

    <button class="upload" onclick={onopenfiles}>
      <Upload size={18} />
      Cargar PDF
    </button>
    <p class="drop-hint">o arrastra tus archivos a esta ventana</p>

    <p class="privacy">
      <ShieldCheck size={16} />
      Tus archivos se procesan en este navegador y nunca se envían a ningún servidor.
    </p>
    {#if pwa.canInstall}
      <button class="install" onclick={() => void pwa.install()}>
        <MonitorDown size={16} />
        Instalar ytaPDF para usarlo sin conexión
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
    border: 1px dashed #c4cad3;
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
    color: #333;
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
    background: #f8fafc;
    list-style: none;
    text-align: left;
  }
  .features li {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    font-weight: 500;
    color: #334155;
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
  .recovery {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin-bottom: 28px;
    padding: 14px 16px;
    border: 1px solid #bcd9f5;
    border-radius: var(--radius-md);
    background: var(--color-primary-soft);
    color: var(--color-primary);
    text-align: left;
  }
  .recovery :global(svg) {
    flex-shrink: 0;
  }
  .recovery-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .recovery-text span {
    color: var(--color-text-muted);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .recovery-actions {
    display: flex;
    gap: 6px;
  }
  .recovery-actions button {
    padding: 7px 12px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .restore {
    border: none;
    background: var(--color-primary);
    color: white;
  }
  .discard {
    border: 1px solid #bcd9f5;
    background: var(--color-surface);
    color: var(--color-text-muted);
  }
  @media (max-width: 600px) {
    .recovery {
      flex-wrap: wrap;
    }
    .recovery-actions {
      width: 100%;
      justify-content: flex-end;
    }
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
