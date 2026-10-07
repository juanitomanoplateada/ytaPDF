<script lang="ts">
  import { editor } from "../editor.svelte";
  import Modal from "./Modal.svelte";

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  const sections: { title: string; items: [string, string][] }[] = [
    {
      title: "Herramientas",
      items: [
        ["V", "Seleccionar"],
        ["T", "Texto"],
        ["E", "Editar el texto del documento"],
        ["Alt + clic", "Editar solo una línea de un párrafo"],
        ["Esc", "Terminar la edición y deseleccionar"],
      ],
    },
    {
      title: "Edición",
      items: [
        [`${mod} Z`, "Deshacer"],
        [`${mod} Y`, "Rehacer"],
        [`${mod} C / ${mod} X / ${mod} V`, "Copiar, cortar y pegar (también imágenes y texto de otras aplicaciones)"],
        [`${mod} D`, "Duplicar"],
        [`${mod} L`, "Bloquear o desbloquear"],
        ["Supr", "Eliminar"],
        ["Flechas", "Mover 1 px (con Mayús, 10 px)"],
        ["Alt al arrastrar", "Mover sin guías de alineación"],
      ],
    },
    {
      title: "Capas",
      items: [
        [`${mod} ] o ${mod} ↑`, "Traer adelante"],
        [`${mod} [ o ${mod} ↓`, "Enviar atrás"],
        [`${mod} Mayús ] o ↑`, "Traer al frente"],
        [`${mod} Mayús [ o ↓`, "Enviar al fondo"],
      ],
    },
    {
      title: "Documento",
      items: [
        [`${mod} O`, "Abrir o añadir PDF"],
        [`${mod} S`, "Exportar PDF"],
        [`${mod} + / ${mod} -`, "Acercar / alejar"],
        [`${mod} 0`, "Zoom al 100 %"],
        [`${mod} + rueda`, "Zoom continuo"],
        ["?", "Mostrar esta ayuda"],
      ],
    },
  ];
</script>

<Modal title="Atajos de teclado" onclose={() => (editor.shortcutsOpen = false)} wide>
  <div class="sections">
    {#each sections as section (section.title)}
      <section>
        <h3>{section.title}</h3>
        <dl>
          {#each section.items as [keys, action] (keys)}
            <div class="item">
              <dt><kbd>{keys}</kbd></dt>
              <dd>{action}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
  <div class="actions">
    <button onclick={() => (editor.shortcutsOpen = false)} data-autofocus>Cerrar</button>
  </div>
</Modal>

<style>
  .sections {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 8px 24px;
    max-height: min(60vh, 520px);
    overflow-y: auto;
    margin-top: 12px;
  }
  h3 {
    margin: 8px 0 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  dl {
    margin: 0;
  }
  .item {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 0;
    border-bottom: 1px solid var(--color-surface-muted);
  }
  dt {
    flex-shrink: 0;
  }
  dd {
    margin: 0;
    font-size: 13px;
  }
  kbd {
    display: inline-block;
    padding: 2px 6px;
    border: 1px solid var(--color-border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--color-surface-muted);
    font-family: inherit;
    font-size: 12px;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .actions button {
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: white;
    font-weight: 500;
    cursor: pointer;
  }
</style>
