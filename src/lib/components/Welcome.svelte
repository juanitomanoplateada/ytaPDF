<script lang="ts">
  import { LayoutGrid, Plus, ShieldCheck, Trash2, Type, Upload } from "lucide-svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();
</script>

<div class="welcome">
  <div class="card">
    <img src="/paty.png" alt="" class="logo" />
    <h1>Bienvenido a <span class="yta">yta</span><span class="pdf">PDF</span></h1>
    <p class="subtitle">La herramienta web rápida y privada para gestionar tus documentos.</p>

    <ul class="features">
      <li><Plus size={20} /> Unir varios PDF</li>
      <li><LayoutGrid size={20} /> Reorganizar páginas</li>
      <li><Trash2 size={20} /> Eliminar hojas</li>
      <li><Type size={20} /> Añadir texto e imágenes</li>
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
