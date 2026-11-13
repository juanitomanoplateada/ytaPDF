<script lang="ts">
  import { editor } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import Modal from "./Modal.svelte";

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  const sections = $derived<{ title: string; items: [string, string][] }[]>([
    {
      title: t("Herramientas"),
      items: [
        ["V", t("Seleccionar")],
        ["T", t("Texto")],
        ["E", t("Editar el texto del documento")],
        ["S", t("Seleccionar texto del documento")],
        ["P", t("Lápiz a mano alzada")],
        ["C", t("Recortar la página")],
        [t("Alt + clic"), t("Editar solo una línea de un párrafo")],
        ["Esc", t("Terminar la edición y deseleccionar")],
      ],
    },
    {
      title: t("Edición"),
      items: [
        [`${mod} Z`, t("Deshacer")],
        [`${mod} Y`, t("Rehacer")],
        [`${mod} C / ${mod} X / ${mod} V`, t("Copiar, cortar y pegar (también imágenes y texto de otras aplicaciones)")],
        [`${mod} D`, t("Duplicar")],
        [`${mod} L`, t("Bloquear o desbloquear")],
        [`${mod} ${t("Mayús")} G`, t("Agrupar o desagrupar")],
        [t("Supr"), t("Eliminar")],
        [t("Flechas"), t("Mover 1 px (con Mayús, 10 px)")],
        [t("Alt al arrastrar"), t("Mover sin guías de alineación")],
      ],
    },
    {
      title: t("Capas"),
      items: [
        [`${mod} ] / ${mod} ↑`, t("Traer adelante")],
        [`${mod} [ / ${mod} ↓`, t("Enviar atrás")],
        [`${mod} ${t("Mayús")} ]`, t("Traer al frente")],
        [`${mod} ${t("Mayús")} [`, t("Enviar al fondo")],
      ],
    },
    {
      title: t("Documento"),
      items: [
        [`${mod} O`, t("Abrir o añadir PDF")],
        [`${mod} S`, t("Exportar PDF (o guardar en el archivo abierto)")],
        [`${mod} ${t("Mayús")} S`, t("Guardar como: nombre, contraseña, imagen…")],
        [`${mod} P`, t("Imprimir")],
        [`${mod} F`, t("Buscar en el documento")],
        [`${mod} G`, t("Ir a una página")],
        [`${mod} + / ${mod} -`, t("Acercar / alejar")],
        [`${mod} 0`, t("Zoom al 100 %")],
        [`${mod} + ${t("rueda")}`, t("Zoom continuo (en el móvil, pellizca)")],
        ["?", t("Mostrar esta ayuda")],
      ],
    },
  ]);
</script>

<Modal title={t("Atajos de teclado")} onclose={() => (editor.shortcutsOpen = false)} wide>
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
